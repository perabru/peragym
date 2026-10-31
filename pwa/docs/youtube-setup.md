# Ativar a conexão YouTube

A integração usa Google Identity Services e YouTube Data API v3. Sem um `googleClientId` válido, o PeraGym deve mostrar a conexão como não configurada. Não há conta ou biblioteca de demonstração conectada.

## Configuração pelo responsável

1. No Google Cloud Console, escolha o projeto do PeraGym e habilite **YouTube Data API v3**.
2. Configure a marca, os dados de contato e a política de privacidade na tela de consentimento OAuth. Solicite apenas `https://www.googleapis.com/auth/youtube.readonly`. Confira o status de verificação e as contas de teste permitidas antes de liberar o acesso ao público.
3. Crie um cliente OAuth do tipo **Aplicativo da Web**. Nas origens JavaScript autorizadas, informe a origem exata da publicação: por exemplo, `https://perabru.github.io`. Não inclua `/peragym/docs/` nesse campo.
4. Copie o Client ID público, terminado em `.apps.googleusercontent.com`, para `googleClientId` no arquivo `pwa/web/music-config.json` e publique novamente. O valor é público; **Client Secret nunca deve entrar no navegador ou no repositório**. As chamadas implementadas usam o token OAuth e não precisam de API Key.

O modelo de token usa popup, sem um endpoint próprio de troca de código. Quando o ambiente definir COOP, use `Cross-Origin-Opener-Policy: same-origin-allow-popups`. A CSP precisa permitir o script `https://accounts.google.com/gsi/client`, frames e conexões de `https://accounts.google.com/gsi/`, além das chamadas à API do YouTube.

## Fluxo no aplicativo

`prepare()` carrega e prepara a biblioteca oficial sem pedir login. A interface habilita a conexão quando `getState().ready` for verdadeiro. No clique do usuário, `connect()` chama `requestAccessToken()` imediatamente, sem aguardar outra operação que possa consumir a ativação do navegador.

O usuário escolhe a conta e concede acesso no popup do Google. O PeraGym só apresenta a conta como conectada após validar o token, o escopo concedido e a resposta real do canal por `channels.list` com `mine=true`. Uma janela bloqueada, fechada ou uma autorização recusada precisa aparecer como erro recuperável.

O token fica somente na memória desta aba. Recarregar a página ou expirar a sessão exige uma nova ação de conexão; não há renovação silenciosa nem token no banco local ou no backup. Ocultar o aplicativo, bloquear a tela ou pausar a música não revoga a autorização. A ação explícita de desconectar apaga a sessão local e solicita a revogação da permissão ao Google quando houver um token válido.

## Alcance da biblioteca

O aplicativo consulta playlists pertencentes ao usuário por `playlists.list` com `mine=true` e seus itens por `playlistItems.list`. As páginas usam até 50 itens; o módulo aplica um limite de segurança de 100 resultados por consulta da interface.

Esses resultados pertencem à **API do YouTube**. Eles não representam uma importação completa da biblioteca do YouTube Music, de downloads, do histórico de reprodução ou dos recursos Premium. Uma playlist privada pode estar disponível para leitura autorizada e continuar impedida de tocar no iframe. Vídeos removidos, privados ou sem permissão de incorporação podem não tocar; os controles e as restrições do player oficial continuam valendo.

## Referências oficiais

- [Configuração do cliente Google](https://developers.google.com/identity/oauth2/web/guides/get-google-api-clientid)
- [Modelo de token e consentimento](https://developers.google.com/identity/oauth2/web/guides/use-token-model)
- [API JavaScript: initTokenClient, requestAccessToken e revoke](https://developers.google.com/identity/oauth2/web/reference/js-reference)
- [Playlists: list](https://developers.google.com/youtube/v3/docs/playlists/list)
- [Channels: list](https://developers.google.com/youtube/v3/docs/channels/list)
- [PlaylistItems: list](https://developers.google.com/youtube/v3/docs/playlistItems/list)
