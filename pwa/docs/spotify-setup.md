# Ativar a conexão Spotify

O PeraGym usa **Authorization Code com PKCE (S256)** no navegador. O campo `spotifyClientId` em `web/music-config.json` começa vazio; nesse estado a interface informa que o responsável ainda precisa configurar a conexão. Nenhuma conta aparece como conectada sem uma autorização real.

Para habilitar a integração em um aplicativo Spotify que você administra:

1. Abra o aplicativo correspondente no [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).
2. Cadastre exatamente o endereço HTTPS da tela do PeraGym como Redirect URI. No GitHub Pages deste projeto, o endereço é `https://perabru.github.io/peragym/docs/app/`. Se utilizar outro domínio ou caminho, cadastre o endereço correspondente e mantenha a integração usando essa mesma URL, sem query ou fragmento.
3. Copie somente o **Client ID público**, de 32 caracteres hexadecimais, para `spotifyClientId` em `web/music-config.json`.
4. Republique a versão web. O usuário poderá tocar em **Conectar Spotify** e autorizar o acesso na página oficial do Spotify.

O aplicativo não solicita senha Spotify nem utiliza Client Secret. O Client ID identifica o aplicativo e pode fazer parte do código público.

## Permissões e funcionamento

O fluxo solicita `streaming`, `user-read-private` e `user-read-email`, documentados para o Web Playback SDK; `playlist-read-private` e `playlist-read-collaborative`, para consultar as playlists autorizadas; e `user-modify-playback-state`, para iniciar ou transferir a reprodução para o player. Não solicita alteração de playlists ou acesso à biblioteca musical inteira. A aplicação não depende dos campos `email` ou `product` do perfil; utiliza `account_id` quando disponível como identificador estável.

A reprodução pelo Web Playback SDK depende das condições e disponibilidade da conta Spotify, incluindo o requisito Premium do SDK. Em modo de desenvolvimento, respeite as contas e limites permitidos no painel do seu aplicativo Spotify. O SDK deve comunicar os erros reais de reprodução à interface.

Access token e refresh token ficam apenas em memória. Recarregar ou fechar a página exige conectar novamente. Apenas o `state` e o `code_verifier` do PKCE, junto com os metadados públicos da autorização, ficam temporariamente em `sessionStorage` nesta aba, por até dez minutos. São consumidos uma única vez no retorno. Nenhum token é salvo em IndexedDB, backup, cookie ou localStorage.

Desconectar remove a sessão local do PeraGym e encerra seu uso de tokens. Para revogar também a permissão no Spotify, remova o acesso do aplicativo nas configurações da conta Spotify.

## Referências oficiais consultadas

- [Fluxo Authorization Code com PKCE](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow)
- [Redirect URIs](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri)
- [Renovação de tokens](https://developer.spotify.com/documentation/web-api/tutorials/refreshing-tokens)
- [Playlists do usuário atual](https://developer.spotify.com/documentation/web-api/reference/get-a-list-of-current-users-playlists)
- [Permissões do Web Playback SDK](https://developer.spotify.com/documentation/web-playback-sdk/howtos/web-app-player)
- [Alterações no perfil em fevereiro de 2026](https://developer.spotify.com/documentation/web-api/references/changes/february-2026)
- [Identificador `account_id`, maio de 2026](https://developer.spotify.com/documentation/web-api/references/changes/may-2026)

O botão de conexão usa uma janela de autorização para manter o PeraGym e seu perfil local abertos. O retorno comunica apenas o código OAuth e seu state para a janela original, que valida origem, janela, PKCE e autorização antes de carregar o player. Se o navegador bloquear a janela ou separar o PWA do navegador, o aplicativo oferece continuação na mesma aba; o perfil com senha pode pedir novo desbloqueio. A reprodução automática depende das permissões do navegador e pode exigir um toque no play.
