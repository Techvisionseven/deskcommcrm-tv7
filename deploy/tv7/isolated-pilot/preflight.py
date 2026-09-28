#!/usr/bin/env python3
"""Preflight de primeira implantação; stdlib, sem escrita, rede externa ou SQL."""
import argparse
import base64
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
from urllib.parse import parse_qs, unquote, urlsplit

DIR = Path(__file__).resolve().parent
PROJECT = "deskcomm_iso"
PORTS = {18080, 18443, 18787, 13030}
NETWORKS = {"backend": "172.29.240.0/24", "edge": "172.29.241.0/24"}
VOLUMES = {"deskcomm_iso_waha_data", "deskcomm_iso_waha_media"}
LIMITS = {"app": (768, 1.5), "worker": (512, 1), "scheduler": (128, .25),
          "waha": (1280, 1.5), "redis": (256, .5), "srh": (128, .25)}
IMAGES = {
    "app": "ghcr.io/melgarafael/deskcommcrm:1.60.0@sha256:30d968f22ed8f6ceb69ad8cd4eb7bc0c217ed80d8da37d97a65a6af2cebe2718",
    "worker": "ghcr.io/melgarafael/deskcomm-worker:1.60.0@sha256:64aa2a021a28018f248c1e6428c8f057e91522443205a91d11d038d83f7890be",
    "scheduler": "ghcr.io/melgarafael/deskcomm-scheduler:1.60.0@sha256:c98929364d40d97cbd1690dca91ce20593b63e6eb661eb5150919e11913ebdfc",
    "waha": "devlikeapro/waha:latest-2026.7.2",
    "redis": "redis:7.4.3-alpine",
    "srh": "hiett/serverless-redis-http@sha256:5b0bb9239fce53abf87b2018a7a0deb9ec7bd900c5360738fe5fbeeb426f9150",
}


class Blocked(Exception):
    pass


def require(condition, message):
    if not condition:
        raise Blocked(message)


def run(args):
    # Nunca imprimir stderr/stdout cru: o Compose pode citar valores do .env.
    try:
        result = subprocess.run(args, cwd=DIR, capture_output=True, text=True,
                                timeout=45, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise Blocked("Consulta indisponível ou timeout: " + args[0]) from None
    require(result.returncode == 0,
            "Consulta falhou: " + " ".join(args[:2]) + "; confira acesso/sintaxe no terminal, sem publicar segredos.")
    return result.stdout


def docker_json(kind, identifier, template):
    return json.loads(run(["docker", kind, "inspect", identifier, "--format", template]))


def compose_model(env_file):
    return json.loads(run(["docker", "compose", "--project-name", PROJECT,
                           "--project-directory", str(DIR), "--env-file", str(env_file),
                           "-f", str(DIR / "compose.yaml"), "config", "--format", "json"]))


def validate_model(model):
    require(model.get("name") == PROJECT, "Nome de projeto incorreto.")
    services = model["services"]
    require(set(services) == set(LIMITS), "Conjunto de serviços diferente dos seis revisados.")
    require(set(model.get("networks", {})) == set(NETWORKS), "Redes não previstas.")
    for key, subnet in NETWORKS.items():
        net = model["networks"][key]
        require(net.get("name") == PROJECT + "_" + key and net.get("driver") == "bridge"
                and not net.get("external") and not net.get("driver_opts")
                and not net.get("enable_ipv6") and not net.get("attachable"), "Rede deve ser bridge própria.")
        require(bool(net.get("internal")) == (key == "backend"), "Isolamento backend/edge alterado.")
        require(net.get("ipam", {}).get("config") == [{"subnet": subnet,
                "gateway": str(ipaddress.ip_network(subnet)[1])}], "IPAM diferente do inventário aprovado.")
    require(set(model.get("volumes", {})) == {"waha_data", "waha_media"}, "Volumes não previstos.")
    for key, volume in model["volumes"].items():
        require(volume.get("name") == PROJECT + "_" + key and not volume.get("external")
                and volume.get("driver", "local") == "local" and not volume.get("driver_opts"),
                "Volume externo ou driver não permitido.")
    for name, svc in services.items():
        for forbidden in ("build", "network_mode", "privileged", "devices", "volumes_from",
                          "pid", "ipc", "uts", "cap_add", "extra_hosts", "profiles",
                          "container_name", "env_file", "secrets", "configs", "deploy"):
            require(not svc.get(forbidden), "Configuração não permitida: " + name + "/" + forbidden)
        require(svc.get("image") == IMAGES[name], "Imagem diferente do pin revisado: " + name)
        expected_nets = {"backend", "edge"} if name in {"app", "worker", "waha"} else {"backend"}
        require(set(svc.get("networks", {})) == expected_nets, "Vínculo de rede inesperado: " + name)
        require(svc.get("restart") == "unless-stopped", "Restart policy inválida: " + name)
        require(svc.get("security_opt") == ["no-new-privileges:true"], "Hardening alterado: " + name)
        mib, cpu = LIMITS[name]
        require(int(svc.get("mem_limit", 0)) == mib * 1024**2
                and float(svc.get("cpus", 0)) == cpu, "Orçamento alterado: " + name)
        require(svc.get("logging") == {"driver": "json-file", "options": {"max-size": "10m", "max-file": "3"}},
                "Rotação de logs alterada: " + name)
        ports = svc.get("ports", [])
        if name == "app":
            require(len(ports) == 1 and ports[0].get("host_ip") == "127.0.0.1"
                    and str(ports[0].get("published")) == "18080" and ports[0].get("target") == 3000
                    and ports[0].get("protocol", "tcp") == "tcp", "App deve publicar somente loopback:18080.")
        else:
            require(not ports, "Porta publicada por serviço interno: " + name)
        mounts = svc.get("volumes", [])
        if name == "waha":
            require(len(mounts) == 2 and {(m.get("type"), m.get("source"), m.get("target")) for m in mounts}
                    == {("volume", "waha_data", "/app/.sessions"), ("volume", "waha_media", "/app/.media")},
                    "Mounts WAHA alterados.")
        else:
            require(not mounts, "Mount não previsto: " + name)
    for name in ("app", "worker"):
        env = services[name]["environment"]
        expected = {"NODE_ENV": "production", "NEXT_PUBLIC_APP_URL": "http://localhost:18080",
                    "NEXT_PUBLIC_ADMIN_URL": "http://localhost:18080", "SUPABASE_SERVER_URL": "",
                    "SUPABASE_DB_ADMIN_URL": "", "WAHA_API_BASE_URL": "http://waha:3000",
                    "WAHA_WEBHOOK_BASE_URL": "http://app:3000", "UPSTASH_REDIS_REST_URL": "http://srh:80"}
        require(all(env.get(k) == v for k, v in expected.items()), "Endpoints de runtime alterados: " + name)
    require(services["srh"]["environment"]["SRH_CONNECTION_STRING"] == "redis://redis:6379",
            "SRH deve usar somente Redis próprio.")


def validate_credentials(model):
    env = model["services"]["app"]["environment"]
    required = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY",
                "SUPABASE_DB_URL", "INTERNAL_SECRET", "CPF_ENCRYPTION_KEY", "AI_CRED_AES_KEY",
                "WAHA_BYO_ENCRYPTION_KEY", "WAHA_API_KEY", "WAHA_HMAC_SECRET", "UPSTASH_REDIS_REST_TOKEN",
                "IMPERSONATE_COOKIE_SECRET", "LGPD_SIGNING_KEY"]
    worker_env = model["services"]["worker"]["environment"]
    for key in required:
        value = env.get(key, "")
        require(isinstance(value, str) and value.strip() == value and value
                and "SUBSTITUIR" not in value.upper(), "Variável ausente ou placeholder: " + key)
        require(worker_env.get(key) == value, "App/worker divergentes: " + key)
    for key in ("CPF_ENCRYPTION_KEY", "AI_CRED_AES_KEY", "WAHA_BYO_ENCRYPTION_KEY"):
        try:
            valid = len(base64.b64decode(env[key], validate=True)) == 32
        except ValueError:
            valid = False
        require(valid, "Cifra deve ter 32 bytes em base64: " + key)
    for key in ("INTERNAL_SECRET", "WAHA_API_KEY", "WAHA_HMAC_SECRET", "UPSTASH_REDIS_REST_TOKEN",
                "IMPERSONATE_COOKIE_SECRET", "LGPD_SIGNING_KEY"):
        require(bool(re.fullmatch(r"[a-fA-F0-9]{64}", env[key])), "Segredo deve ter 64 caracteres hex: " + key)
    waha = model["services"]["waha"]["environment"]
    require(waha["WAHA_API_KEY"] == "sha512:" + hashlib.sha512(env["WAHA_API_KEY"].encode()).hexdigest(),
            "Hash WAHA não corresponde à chave; nenhum valor foi exibido.")
    require(model["services"]["srh"]["environment"]["SRH_TOKEN"] == env["UPSTASH_REDIS_REST_TOKEN"],
            "Tokens SRH diferentes.")
    require(model["services"]["scheduler"]["environment"]["INTERNAL_SECRET"] == env["INTERNAL_SECRET"],
            "Segredo scheduler diferente.")
    url = urlsplit(env["NEXT_PUBLIC_SUPABASE_URL"])
    require(url.scheme == "https" and bool(re.fullmatch(r"[a-z0-9]{20}\.supabase\.co", url.hostname or ""))
            and not url.username and not url.query and url.path in ("", "/"), "Exige URL de projeto Supabase gerenciado.")
    ref = url.hostname.split(".")[0]
    # O piloto usa as chaves JWT anon/service_role compatíveis com esta release.
    for key, role in (("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon"), ("SUPABASE_SERVICE_ROLE_KEY", "service_role")):
        try:
            payload = env[key].split(".")[1]
            claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        except (ValueError, IndexError):
            raise Blocked("Chave JWT malformada: " + key) from None
        require(claims.get("ref") == ref and claims.get("role") == role, "Projeto/papel divergente: " + key)
    db = urlsplit(env["SUPABASE_DB_URL"])
    require(db.scheme in ("postgresql", "postgres") and db.password and db.path == "/postgres"
            and db.port == 5432 and (db.hostname or "").endswith(".pooler.supabase.com")
            and unquote(db.username or "").endswith("." + ref)
            and parse_qs(db.query).get("sslmode") in (["require"], ["verify-full"]),
            "DB deve usar Session pooler 5432 do mesmo projeto, senha e TLS.")
    pilot = model.get("x-pilot", {})
    require(pilot.get("supabase_ready") == "yes" and pilot.get("schema_release") == "1.60.0",
            "Confirme preparo externo: PILOT_SUPABASE_READY=yes e PILOT_SCHEMA_RELEASE=1.60.0.")


def validate_ports(ss_output, service_ports, container_ports):
    occupied = set()
    for line in ss_output.splitlines():
        fields = line.split()
        if not fields:
            continue
        require(len(fields) >= 5 and fields[0] == "LISTEN", "Formato inesperado em ss -H -lnt.")
        port = fields[3].rsplit(":", 1)[-1]
        require(port.isdigit(), "Porta não numérica na inspeção ss.")
        occupied.add(int(port))
    for ports in service_ports:
        for port in ports or []:
            if port.get("Protocol", "tcp") == "tcp":
                occupied.add(int(port["PublishedPort"]))
    for mapping in container_ports:
        for target, bindings in (mapping or {}).items():
            if target.endswith("/tcp"):
                for binding in bindings or []:
                    occupied.add(int(binding["HostPort"]))
    require(not occupied & PORTS, "Portas candidatas ocupadas: " + ", ".join(map(str, sorted(occupied & PORTS))))


def validate_subnets(networks, routes, addresses):
    existing = []
    for net in networks:
        require(net["name"] not in {PROJECT + "_" + k for k in NETWORKS},
                "Nome de network já existe; primeira implantação exige nomes livres.")
        existing += [c["Subnet"] for c in net.get("ipam") or [] if c.get("Subnet")]
    for route in routes:
        dest = route.get("dst")
        # A rota default é saída geral, não uma faixa privada já alocada.
        if dest and dest not in ("default", "0.0.0.0/0", "::/0"):
            existing.append(dest)
    for interface in addresses:
        existing += [f"{a['local']}/{a['prefixlen']}" for a in interface.get("addr_info", [])]
    for candidate in NETWORKS.values():
        subnet = ipaddress.ip_network(candidate)
        for item in existing:
            other = ipaddress.ip_network(item, strict=False)
            require(not subnet.overlaps(other), "Subnet candidata conflita com rede/rota/interface existente: " + candidate)


def validate_resources(available_mib, free_bytes, free_inodes):
    require(available_mib >= 5120, "RAM disponível abaixo de 5120 MiB (3072 MiB piloto + 2048 MiB de margem).")
    require(free_bytes >= 15 * 1024**3, "Disco disponível abaixo de 15 GiB no armazenamento Docker.")
    require(free_inodes >= 100000, "Menos de 100 mil inodes disponíveis no armazenamento Docker.")


def validate_host():
    # ss/rotas/recursos são locais; não aceitar um daemon remoto por engano.
    if os.environ.get("DOCKER_HOST"):
        require(os.environ["DOCKER_HOST"] == "unix:///var/run/docker.sock", "DOCKER_HOST remoto/não padrão.")
    context = json.loads(run(["docker", "context", "inspect"]))
    require(context[0]["Endpoints"]["docker"]["Host"] == "unix:///var/run/docker.sock", "Contexto Docker não é o daemon local padrão.")
    info = json.loads(run(["docker", "info", "--format", '{"swarm":{{json .Swarm.LocalNodeState}},"manager":{{.Swarm.ControlAvailable}},"root":{{json .DockerRootDir}},"arch":{{json .Architecture}}}']))
    require(info["swarm"] == "active" and info["manager"], "Esperado Swarm ativo com manager; não será corrigido.")
    require(info["arch"] in ("x86_64", "amd64"), "As imagens revisadas exigem amd64.")
    require(not run(["docker", "ps", "-aq", "--filter", "label=com.docker.compose.project=" + PROJECT]).strip(),
            "Projeto deskcomm_iso já possui containers (ativos ou parados); não é primeira implantação.")
    names = set(run(["docker", "volume", "ls", "--format", "{{.Name}}"]).splitlines())
    require(not names & VOLUMES, "Volume do piloto já existe; não reutilizar dados sem revisão.")
    networks = [docker_json("network", ident, '{"name":{{json .Name}},"ipam":{{json .IPAM.Config}}}')
                for ident in run(["docker", "network", "ls", "-q"]).split()]
    routes = json.loads(run(["ip", "-j", "route", "show", "table", "all"]))
    routes += json.loads(run(["ip", "-j", "-6", "route", "show", "table", "all"]))
    addresses = json.loads(run(["ip", "-j", "address", "show"]))
    validate_subnets(networks, routes, addresses)
    service_ports = [docker_json("service", ident, "{{json .Endpoint.Spec.Ports}}")
                     for ident in run(["docker", "service", "ls", "-q"]).split()]
    container_ports = [docker_json("container", ident, "{{json .HostConfig.PortBindings}}")
                       for ident in run(["docker", "ps", "-q"]).split()]
    validate_ports(run(["ss", "-H", "-lnt"]), service_ports, container_ports)
    memory = dict(re.findall(r"^(\w+):\s+(\d+)", Path("/proc/meminfo").read_text(), re.M))
    available = int(memory["MemAvailable"]) // 1024
    # Usa o filesystem real do Docker, não presume que /var/lib/docker está em /.
    disk = shutil.disk_usage(info["root"])
    fs = os.statvfs(info["root"])
    validate_resources(available, disk.free, fs.f_favail)
    print(f"Host: RAM disponível {available} MiB; disco Docker {disk.free // 1024**3} GiB.")
    if int(memory.get("SwapTotal", 0)) == 0:
        print("AVISO: sem swap; snapshot não mede picos do legado.")
    print("Host: portas, subnets e nomes livres; nenhum recurso foi criado.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--static", action="store_true", help="Só estrutura com .env.example; não atesta deploy.")
    args = parser.parse_args()
    for tool in (("docker",) if args.static else ("docker", "ip", "ss")):
        require(shutil.which(tool), "Ferramenta necessária ausente: " + tool)
    env_file = DIR / (".env.example" if args.static else ".env")
    require(env_file.is_file(), "Arquivo necessário ausente: " + env_file.name)
    if not args.static:
        require(not env_file.is_symlink() and stat.S_IMODE(env_file.stat().st_mode) == 0o600,
                "O .env do piloto deve ser arquivo regular, sem symlink, com modo 600.")
    run(["docker", "compose", "version"])
    model = compose_model(env_file)
    validate_model(model)
    if args.static:
        print("OK estático: seis serviços, loopback, isolamento, limites e logs. NÃO autoriza deployment.")
    else:
        validate_credentials(model)
        validate_host()
        print("OK preflight de primeira implantação; sem teste de credenciais/schema remoto, tráfego ou pico.")


if __name__ == "__main__":
    try:
        main()
    except Blocked as exc:
        print("BLOQUEADO: " + str(exc), file=sys.stderr)
        sys.exit(1)
    except (ValueError, KeyError, TypeError, OSError):
        print("BLOQUEADO: resposta/formato inesperado; detalhes omitidos para preservar segredos.", file=sys.stderr)
        sys.exit(1)
