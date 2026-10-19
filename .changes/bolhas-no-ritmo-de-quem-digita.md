---
impacto: nada_mudou
secao: corrigido
titulo: As respostas em várias mensagens do agente saem no ritmo de quem digita
---

Com "dividir a resposta em mensagens" ligado, a primeira mensagem já esperava o tempo de alguém ler e digitar, mas as seguintes saíam com pouco mais de um segundo entre elas: três mensagens longas chegavam em menos de cinco segundos, o que ninguém consegue digitar. Agora cada mensagem seguinte espera o tempo de ser digitada, proporcional ao tamanho dela e com teto, no ritmo de digitação configurado para a conexão (os campos "Por caractere" e "Mínimo" do atraso humano, em Conexões › Proteção de envio; vazios, valem os padrões), e nunca menos que o intervalo de proteção contra bloqueio do número, que continua valendo como antes. A espera a mais é limitada por resposta, para o atendimento não ficar parado. Não há ação para quem opera a VPS.
