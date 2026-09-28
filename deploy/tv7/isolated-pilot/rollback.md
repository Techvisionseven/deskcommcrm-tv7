# Rollback exclusivo do projeto deskcomm_iso

**Procedimentos futuros, NÃO EXECUTADOS.** Requerem autorização operacional.
Nunca usar `docker stack`, prune, nomes de serviços legados, `down -v`, remoção de
volumes ou remoção de imagens. Nunca executar o `update.sh` oficial neste piloto.

## 1. Interromper um primeiro deployment malsucedido

Para parar somente os seis serviços do piloto, preservando containers, redes e dados:

```bash
cd /opt/deskcomm/core
sudo docker compose -p deskcomm_iso --env-file deploy/tv7/isolated-pilot/.env -f deploy/tv7/isolated-pilot/compose.yaml stop
```

Isso não reverte schema, mensagens enviadas, crons executados ou outros efeitos
externos. Para retirar containers/redes **apenas do piloto**, após conferir o
projeto e com autorização específica:

```bash
sudo docker compose -p deskcomm_iso --env-file deploy/tv7/isolated-pilot/.env -f deploy/tv7/isolated-pilot/compose.yaml down
```

Sem `-v`, sem `--rmi` e sem `--remove-orphans`. Os dois volumes WAHA permanecem.
Não apagar volumes para fazer o preflight passar: ele é de primeira implantação;
uma retomada com dados existentes exige revisão própria.

## 2. Rollback de configuração

Guardar antes de qualquer mudança o commit aprovado e cópia criptografada do `.env`.
Restaurar somente a pasta do piloto a partir de uma revisão conhecida, deixando o
core e `main` intactos. Exemplo futuro, depois de definir `PILOT_PREVIOUS_COMMIT`
como SHA aprovado e conferir árvore Git limpa:

```bash
cd /opt/deskcomm/core
git restore --source="${PILOT_PREVIOUS_COMMIT:?Defina o SHA aprovado}" -- deploy/tv7/isolated-pilot
bash deploy/tv7/isolated-pilot/preflight.sh --static
sudo docker compose -p deskcomm_iso --env-file deploy/tv7/isolated-pilot/.env -f deploy/tv7/isolated-pilot/compose.yaml config --quiet
sudo docker compose -p deskcomm_iso --env-file deploy/tv7/isolated-pilot/.env -f deploy/tv7/isolated-pilot/compose.yaml up -d --no-build --pull never --wait --wait-timeout 300
```

`git restore` aqui modifica arquivos de trabalho, não reescreve histórico. Só usar
quando o SHA tiver a pasta e o schema continuar compatível; revisar/commitar o
rollback em branch separada. Não restaurar `.env` de outra instalação nem trocar
chaves de cifra em dados existentes. O `.env` não é recuperado pelo Git.

## 3. Rollback de imagem

Voltar ao Compose aprovado recupera os digests anteriores de app/worker/scheduler
em conjunto. Confirmar antes que as imagens estão presentes localmente; `--pull
never` falha se faltarem, em vez de construir ou escolher outra versão.
Caso faltem, um `pull` das referências aprovadas exige autorização e acesso ao
registry. Registrar também digests de WAHA/Redis antes de futuras atualizações,
pois suas tags são de terceiros. Não usar `latest`/`stable` como histórico.

## 4. Schema incompatível

Reverter imagens **não reverte migrations**. Se houve mudança incompatível no
Supabase, não executar o `up` acima. Parar app/worker/scheduler/WAHA do piloto,
avaliar correção aditiva para frente ou recuperação em projeto externo separado,
e aprovar a combinação de schema e imagens. Nunca reaplicar baseline antigo como
se fosse um downgrade seguro. Nenhuma migration é executada pelo nosso Compose.

## 5. Restauração de dados

É operação diferente de rollback de imagem/configuração: pode perder escritas
posteriores ao backup e requer aprovação do ponto de recuperação. Seguir
[backup.md](backup.md), testar em destino isolado e preservar o conjunto de chaves.
Mensagens WhatsApp já enviadas não são desfeitas por restaurar o banco.

Não há nenhuma instrução neste procedimento para alterar PostgreSQL/Redis legados,
Traefik, overlays, stacks ou volumes existentes fora de `deskcomm_iso`.
