---
impacto: nada_mudou
secao: corrigido
titulo: A mensagem que o cliente manda logo depois de uma resposta da IA não fica mais sem resposta
---

Quando a IA já tinha respondido ao cliente e a etapa final do turno (o resumo que ela grava para o turno seguinte) falhava — por um resumo em formato inválido ou por um erro do provedor de IA —, o atendimento inteiro voltava para a fila e rodava de novo. Se o cliente escrevesse nesse intervalo, a nova mensagem era juntada ao atendimento que esperava a nova tentativa: a IA escrevia a resposta, mas ela era descartada como se já tivesse sido enviada, e o cliente ficava minutos sem retorno. Agora, com a resposta já entregue, a falha que sobra nessa etapa final (o resumo ainda inválido depois da correção que já é pedida ao modelo, ou um erro do provedor de IA) encerra o turno sem o resumo, e o motivo fica anotado no job; sem resposta entregue, nada muda. A mensagem que chega enquanto um atendimento espera nova tentativa abre o próprio turno e é respondida. Nenhuma resposta sai em dobro. Não há ação para quem opera a VPS.
