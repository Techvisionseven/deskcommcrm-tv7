---
impacto: nada_mudou
secao: corrigido
titulo: O cliente é avisado da passagem para uma pessoa uma vez só, e sem ouvir que não há ninguém
---

Quando o agente de IA decidia passar a conversa para uma pessoa e escrevia ele mesmo o aviso ao cliente ("vou passar o atendimento para uma pessoa da equipe…"), o sistema podia mandar, dois segundos depois, o aviso automático com outras palavras. Isso acontecia quando o agente escrevia e pedia a passagem no mesmo passo: o aviso automático conferia se o agente já tinha falado antes de a mensagem dele terminar de sair. Agora ele espera a fala do agente e só é enviado quando o agente não disse nada, por exemplo quando o próprio sistema reconhece o pedido de atendente antes de o agente responder. O cliente continua sempre avisado, e uma vez só.

O aviso automático também deixou de dizer "No momento ninguém está disponível" quando a equipe existe mas ninguém está de plantão. Ele passa a dizer que o pedido ficou anotado, com o resumo da conversa para quem assumir, em português e em espanhol. Não há ação para quem opera a VPS.
