"""Testes sem daemon, containers, credenciais reais ou arquivos temporários."""
import base64
import copy
from contextlib import redirect_stdout
import hashlib
import io
import json
import unittest
from unittest.mock import patch

import preflight as p


class PreflightTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.model = p.compose_model(p.DIR / ".env.example")

    def test_compose_real_isolado(self):
        p.validate_model(self.model)

    def test_publicacao_aberta_reprovada(self):
        model = copy.deepcopy(self.model)
        model["services"]["app"]["ports"][0]["host_ip"] = "0.0.0.0"
        with self.assertRaises(p.Blocked):
            p.validate_model(model)

    def test_sabotagens_de_isolamento(self):
        mutations = [
            lambda m: m["networks"]["backend"].update(external=True),
            lambda m: m["networks"]["backend"].update(name="techvision"),
            lambda m: m["services"]["redis"].update(network_mode="host"),
            lambda m: m["services"]["worker"].update(privileged=True),
            lambda m: m["services"]["worker"].update(volumes=[{"type": "bind", "source": "/var/run/docker.sock", "target": "/var/run/docker.sock"}]),
            lambda m: m["services"]["app"].update(mem_limit=8 * 1024**3),
            lambda m: m["services"]["app"]["logging"]["options"].update({"max-file": "100"}),
            lambda m: m["services"]["app"]["ports"][0].update(published="80"),
            lambda m: m["services"]["app"].update(image="ghcr.io/melgarafael/deskcommcrm:latest"),
        ]
        for mutate in mutations:
            model = copy.deepcopy(self.model)
            mutate(model)
            with self.subTest(mutation=mutate), self.assertRaises(p.Blocked):
                p.validate_model(model)

    def test_porta_swarm_sem_listener_tambem_bloqueia(self):
        with self.assertRaises(p.Blocked):
            p.validate_ports("", [[{"PublishedPort": 18080, "Protocol": "tcp"}]], [])

    def test_porta_container_bloqueia(self):
        with self.assertRaises(p.Blocked):
            p.validate_ports("", [], [{"3000/tcp": [{"HostPort": "13030"}]}])

    def test_listener_ipv6_bloqueia(self):
        with self.assertRaises(p.Blocked):
            p.validate_ports("LISTEN 0 128 [::]:18443 [::]:*", [], [])

    def test_portas_legadas_nao_sao_alvos(self):
        p.validate_ports("LISTEN 0 128 0.0.0.0:443 0.0.0.0:*", [[{"PublishedPort": 5432}]], [])

    def test_subnets_do_inventario_nao_conflitam(self):
        nets = [{"name": str(i), "ipam": [{"Subnet": n}]} for i, n in enumerate(
            ["172.17.0.0/16", "172.18.0.0/16", "10.0.0.0/24", "10.0.1.0/24", "10.0.2.0/24"])]
        p.validate_subnets(nets, [{"dst": "default"}, {"dst": "38.242.208.0/20"}], [])

    def test_rota_vpn_ampla_bloqueia(self):
        with self.assertRaises(p.Blocked):
            p.validate_subnets([], [{"dst": "172.16.0.0/12", "dev": "tun0"}], [])

    def test_rede_interface_e_nome_colidindo(self):
        with self.assertRaises(p.Blocked):
            p.validate_subnets([{"name": "outra", "ipam": [{"Subnet": "172.29.240.128/25"}]}], [], [])
        with self.assertRaises(p.Blocked):
            p.validate_subnets([], [], [{"addr_info": [{"local": "172.29.241.3", "prefixlen": 24}]}])
        with self.assertRaises(p.Blocked):
            p.validate_subnets([{"name": "deskcomm_iso_backend", "ipam": []}], [], [])

    def test_recursos_insuficientes_bloqueiam(self):
        for values in [(5000, 20 * 1024**3, 200000), (8000, 10 * 1024**3, 200000), (8000, 20 * 1024**3, 100)]:
            with self.subTest(values=values), self.assertRaises(p.Blocked):
                p.validate_resources(*values)
        p.validate_resources(7831, 76 * 1024**3, 5681049)

    def test_placeholders_nao_passam_por_prontidao(self):
        with self.assertRaises(p.Blocked):
            p.validate_credentials(self.model)

    def credentials_model(self):
        model = copy.deepcopy(self.model)
        env = model["services"]["app"]["environment"]
        for key in ("CPF_ENCRYPTION_KEY", "AI_CRED_AES_KEY", "WAHA_BYO_ENCRYPTION_KEY"):
            env[key] = base64.b64encode(b"x" * 32).decode()
        for key in ("INTERNAL_SECRET", "WAHA_API_KEY", "WAHA_HMAC_SECRET", "UPSTASH_REDIS_REST_TOKEN",
                    "IMPERSONATE_COOKIE_SECRET", "LGPD_SIGNING_KEY"):
            env[key] = "a" * 64
        ref = "abcdefghijklmnopqrst"
        for key, role in (("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon"), ("SUPABASE_SERVICE_ROLE_KEY", "service_role")):
            payload = base64.urlsafe_b64encode(json.dumps({"ref": ref, "role": role}).encode()).decode().rstrip("=")
            env[key] = "fake." + payload + ".fake"
        env["NEXT_PUBLIC_SUPABASE_URL"] = "https://" + ref + ".supabase.co"
        env["SUPABASE_DB_URL"] = "postgresql://postgres." + ref + ":fake@aws-0-test.pooler.supabase.com:5432/postgres?sslmode=require"
        model["services"]["waha"]["environment"]["WAHA_API_KEY"] = "sha512:" + hashlib.sha512(env["WAHA_API_KEY"].encode()).hexdigest()
        model["services"]["srh"]["environment"]["SRH_TOKEN"] = "a" * 64
        model["services"]["scheduler"]["environment"]["INTERNAL_SECRET"] = "a" * 64
        model["services"]["worker"]["environment"] = copy.deepcopy(env)
        model["x-pilot"] = {"supabase_ready": "yes", "schema_release": "1.60.0"}
        return model

    def test_contrato_credenciais_sinteticas(self):
        # Não valida assinatura/autenticidade remota; valida forma e consistência.
        p.validate_credentials(self.credentials_model())

    def test_banco_legado_e_pooler_transaction_recusados(self):
        for uri in ("postgresql://postgres:fake@postgres:5432/postgres", "postgresql://postgres.abcdefghijklmnopqrst:fake@aws-0-test.pooler.supabase.com:6543/postgres?sslmode=require"):
            model = self.credentials_model()
            model["services"]["app"]["environment"]["SUPABASE_DB_URL"] = uri
            model["services"]["worker"]["environment"]["SUPABASE_DB_URL"] = uri
            with self.assertRaisesRegex(p.Blocked, "Session pooler"):
                p.validate_credentials(model)

    def test_hash_waha_errado_recusado(self):
        model = self.credentials_model()
        model["services"]["waha"]["environment"]["WAHA_API_KEY"] = "sha512:incorreto"
        with self.assertRaises(p.Blocked):
            p.validate_credentials(model)

    def test_falha_de_comando_nao_vaza_segredo(self):
        result = p.subprocess.CompletedProcess([], 1, "SEGREDO", "SEGREDO")
        with patch.object(p.subprocess, "run", return_value=result):
            with self.assertRaises(p.Blocked) as caught:
                p.run(["docker", "compose", "config"])
            self.assertNotIn("SEGREDO", str(caught.exception))

    def test_worker_com_credencial_diferente_bloqueia(self):
        model = self.credentials_model()
        model["services"]["worker"]["environment"]["INTERNAL_SECRET"] = "b" * 64
        with self.assertRaises(p.Blocked):
            p.validate_credentials(model)

    def test_formato_ss_desconhecido_bloqueia(self):
        with self.assertRaises(p.Blocked):
            p.validate_ports("formato desconhecido", [], [])

    def test_host_apenas_consulta_e_recusa_erros(self):
        commands = []

        def fake_run(args):
            commands.append(args)
            if args[:3] == ["docker", "context", "inspect"]:
                return json.dumps([{"Endpoints": {"docker": {"Host": "unix:///var/run/docker.sock"}}}])
            if args[:2] == ["docker", "info"]:
                return json.dumps({"swarm": "active", "manager": True, "root": "/", "arch": "x86_64"})
            if args[:2] == ["docker", "ps"] or args[:3] in (["docker", "volume", "ls"], ["docker", "network", "ls"], ["docker", "service", "ls"]):
                return ""
            if args[0] == "ip":
                return "[]"
            if args[0] == "ss":
                return ""
            raise AssertionError("Consulta não prevista: " + repr(args))

        with patch.dict(p.os.environ, {}, clear=True), patch.object(p, "run", side_effect=fake_run), \
                patch.object(p.Path, "read_text", return_value="MemAvailable: 8000000 kB\nSwapTotal: 0 kB\n"), \
                patch.object(p.shutil, "disk_usage", return_value=type("Disk", (), {"free": 20 * 1024**3})()), \
                patch.object(p.os, "statvfs", return_value=type("FS", (), {"f_favail": 200000})()):
            with redirect_stdout(io.StringIO()):
                p.validate_host()
        self.assertTrue(commands)
        with patch.dict(p.os.environ, {}, clear=True), patch.object(p, "run", side_effect=p.Blocked("acesso negado")):
            with self.assertRaises(p.Blocked):
                p.validate_host()


if __name__ == "__main__":
    unittest.main()
