---
impacto: capacidade_nova
secao: adicionado
titulo: A conexão de Dados externos passa a guardar o tipo do banco e um espaço para o aviso do último teste
---

Cada conexão de Dados externos passa a guardar qual é o banco do outro lado (por enquanto, só PostgreSQL) e ganha um espaço para um aviso do último teste, que por enquanto fica sempre vazio: só o MySQL, quando chegar, vai preenchê-lo. Nada muda na tela, e as conexões que já existem ficam marcadas como PostgreSQL, sem aviso. Se a sua integração lê a lista de conexões pela API, ela passa a ver também os campos `db_type` (hoje sempre `postgres`) e `last_test_aviso` (hoje sempre vazio); e as ferramentas do assistente que consultam o banco externo passam a dizer o tipo do banco no campo `motor`. A atualização acrescenta duas colunas na tabela de conexões e não exige nenhuma ação de quem opera a instalação.

Desenho e código de @paulolimajr77 (Spec 23, fatia 4a-1, #2637).
