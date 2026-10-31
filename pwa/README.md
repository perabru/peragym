# PeraGym — PWA

HTML, CSS e JavaScript com IndexedDB local. A publicação atual é [GitHub Pages](https://perabru.github.io/peragym/).

## Recursos

- Criar, editar e excluir fichas; alterar exercícios, séries, repetições, cargas e descanso. Excluir uma ficha mantém o histórico de treinos concluídos.
- Histórico de treinos e gráficos de cargas e peso corporal.
- Temas claro e escuro, instalação Android/iPhone e treinos offline.
- Uso sem cadastro e perfil local com senha opcional, com bancos separados.
- Desbloqueio pelo dispositivo com WebAuthn PRF quando disponível; senha como alternativa.
- Recuperação local da senha com usuário e código aleatório guardado fora do aplicativo.
- Importação explícita dos treinos da versão anterior e backup JSON dos registros e dos oito links recentes de música.
- Player único para links do YouTube Music e Spotify, com controles conforme o serviço.
- Autorização Spotify PKCE e SDK; autorização Google para playlists e vídeos da API YouTube, com Client IDs configurados.
- Loading independente do módulo principal, recuperação de falhas e instalação direta.
- Pix opcional de R$ 1,99 no início do site, com QR Code e copia e cola; instalação e uso livres.

## Build estático

```sh
npm ci
npm test
npm run build:pages
npm run build:pages -- --check
```

O build copia apenas os recursos públicos de `web/` para `../docs/`, adapta os caminhos para `/peragym/docs/`, gera `donation.json`, o redirecionamento de download e a entrada da raiz. Inclua a saída gerada no commit. O modo `--check` falha quando a publicação não corresponde às fontes.

O manifesto, o escopo do service worker, os recursos locais e a instalação usam a mesma base. Músicas e recursos externos do YouTube não entram no cache offline. Os dados de treino ficam no navegador; outro domínio exige exportar/importar um backup.

`server/worker.js`, `scripts/build.sh`, `db/` e `drizzle/` são da hospedagem anterior. O build do GitHub Pages não os publica nem depende deles. As tabelas antigas não são alteradas.

## Perfis e banco local

O modo sem cadastro usa `peragym-guest-v1`, separado dos perfis e do banco legado. Os registros são cifrados com uma CryptoKey local não extraível; como a chave permanece disponível no aparelho, esse modo não exige senha e pode ser aberto por quem tiver acesso ao aplicativo. Criar um perfil com senha é opcional.

Cada perfil tem um vault AES-GCM em IndexedDB. A senha não é gravada: PBKDF2 deriva a chave usada para abrir o envelope da chave aleatória do perfil. O desbloqueio mantém essa chave apenas em memória. Perfis e dados não são enviados a um servidor. O cadastro começa vazio; a importação dos treinos anteriores é explícita e preserva o banco original.

A biometria requer WebAuthn com extensão PRF, além da verificação do usuário no aparelho. Sem suporte, permanece disponível o login com senha. O navegador decide se oferece digital, Face ID ou PIN; o PeraGym não recebe dados biométricos.

**Esqueci minha senha** exige o usuário e um código de recuperação aleatório gerado previamente e guardado pelo usuário fora do app. A redefinição funciona no mesmo aparelho, com o banco local preservado. Contas antigas precisam ativar o código em **Ajustes** enquanto estão logadas. Não há recuperação por e-mail se senha e código forem perdidos. Apagar os dados do site remove contas e treinos; o código não restaura um banco apagado. Exporte os treinos antes de trocar de aparelho; o backup JSON é legível.

## Música

Links são validados antes de carregar o player oficial. O YouTube mantém seu IFrame visível, pausa quando o aplicativo é ocultado ou um formulário cobre a tela e oferece abertura externa quando o conteúdo não permite incorporação.

Spotify usa OAuth PKCE e Web Playback SDK, com tokens somente em memória e verificador temporário de uso único. Google usa Google Identity Services e o escopo `youtube.readonly`. O aplicativo percorre as páginas de playlists e faixas retornadas pelas APIs, conforme as permissões da conta e do projeto. Não há API oficial para importar toda a biblioteca do YouTube Music, liberar recursos Premium ou reproduzir vídeos que bloqueiam incorporação.

Os Client IDs públicos globais em `web/music-config.json` continuam vazios: a ativação padrão está pendente. **Ajustes** permite salvar os dois IDs por perfil, no `localStorage` sob `peragym.music.config.v1.<profileId>`. Essa configuração pública é independente do cofre e não altera senhas, chaves ou backups de treino. Só aceita os campos `spotifyClientId` e `googleClientId`; senhas, tokens e Client Secrets são rejeitados. O app mostra a origem e o callback que devem estar registrados nos painéis das aplicações. Salvar IDs não conecta uma conta: o usuário ainda autoriza no serviço oficial. A ativação e os limites estão em [Spotify](docs/spotify-setup.md) e [Google/YouTube](docs/youtube-setup.md).

Referências: [IFrame](https://developers.google.com/youtube/iframe_api_reference) e [políticas](https://developers.google.com/youtube/terms/developer-policies).

## Recursos visuais

Cassete e palmeiras em SVG originais. Imagem de referência fornecida pelo usuário em `web/assets/night-drive.jpg`. Fontes locais Bungee (OFL) e Yellowtail (Apache 2.0), com licenças em `web/assets/fonts/`.
