# Backup e restauração — estratégia, não executada

Escopo exclusivo: projeto `deskcomm_iso` e seu Supabase gerenciado novo. Não usar
credenciais, volumes, banco ou scripts operacionais das stacks legadas.

## O que precisa ser protegido

| Conjunto | Estratégia | Evidência de restauração exigida |
|---|---|---|
| Banco gerenciado | Backup/PITR conforme plano e exportação lógica independente, criptografada e fora da VPS | Restaurar em projeto descartável exclusivo; conferir tabelas, RLS/grants, funções, dados e autenticação |
| Supabase Storage | Copiar objetos dos buckets via API Storage/S3 autorizada, com inventário e checksums | Abrir anexos restaurados; verificar buckets privados e permissões |
| Auth e configuração externa | Registrar Site URL, redirects, templates de e-mail, SMTP, Realtime e extensões; segredos em cofre separado | Login/reset e evento Realtime funcionando no destino |
| Configuração local | Guardar commit, Compose e digests; `.env` criptografado fora do Git | Recuperar o mesmo conjunto de chaves e parâmetros |
| Sessões WAHA | Snapshot consistente de `deskcomm_iso_waha_data`, coordenado com parada **somente do WAHA do piloto** em janela autorizada | Pareamento e recebimento/envio de teste confirmados; provedor pode exigir novo QR |
| Mídia WAHA | Proteger `deskcomm_iso_waha_media` junto das sessões; não confundir com Storage remoto | Recuperar mídia ainda referenciada e verificar integridade |
| Redis | Efêmero; sem backup | Reconhecer perda de contadores/cache e janela de rate limit após reinício |

Não perder `CPF_ENCRYPTION_KEY`, `AI_CRED_AES_KEY` e `WAHA_BYO_ENCRYPTION_KEY`:
restaurar dados cifrados sem as chaves correspondentes não recupera seu conteúdo.
Segredos e dumps não devem entrar em logs, PRs, terminal compartilhado ou Git.

Cadência proposta para o piloto: backup antes de cada mudança de imagem/schema,
exportação diária de dados e objetos, retenção inicial de 14 diários e 4 semanais,
com destino externo criptografado. Definir responsável, RPO/RTO e alertas antes de
receber dados reais. Um arquivo gerado sem teste de restauração não encerra o trabalho.

## Limites do kit oficial

`hostgator-setup-kit/backup.sh` usa `_common.sh`, resolução de projeto/volumes e
Compose oficiais; não executá-lo cegamente nesta camada. Ele gera dump SQL e tar
de sessões WAHA, com verificação básica e retenção local. O backup dos objetos
Storage só aparece no ramo **single-server**, lendo o filesystem daquele Supabase.
Portanto **não cobre automaticamente objetos do Supabase gerenciado**, nem faz
cópia externa ou prova completa de restauração do piloto.

O backup de banco do Supabase também não inclui os próprios objetos Storage;
preservá-los separadamente. Disponibilidade/retenção de backups e PITR dependem
do plano efetivo; não foram presumidas nem verificadas para um projeto inexistente.
[Documentação oficial](https://supabase.com/docs/guides/platform/backups).

## Ordem de restauração futura

1. Aprovar a janela e destino; interromper somente os escritores do piloto.
2. Validar checksums e a correspondência de imagem, schema, dados e chaves.
3. Restaurar primeiro em um projeto Supabase de recuperação exclusivo; recuperar
   Auth, dados, funções/permissões e a configuração externa aplicável.
4. Restaurar objetos Storage e conferir referências/privacidade.
5. Recuperar configuração e volumes WAHA do piloto, sem tocar nos volumes legados.
6. Subir versões compatíveis; provar login, anexos, Realtime e WhatsApp em teste
   controlado. Só depois apontar a operação para o destino recuperado.

Nenhum comando de backup/restauração foi executado nesta preparação. A implementação
de cópia e um ensaio de recuperação são pendências explícitas antes de dados reais.
