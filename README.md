# PeraGym 3.4

**[Abrir o site](https://perabru.github.io/peragym/) · [Abrir o aplicativo](https://perabru.github.io/peragym/docs/app/)**

PWA gratuito para Android e iPhone. Fichas de treino, cargas em quilos, peso corporal, gráficos e histórico no banco local do aparelho. Visual neon e fita cassete nos botões de salvar.

A abertura mostra uma tela de carregamento e o login local. Cada perfil tem seus próprios treinos, protegidos por senha e criptografia AES-GCM. Em aparelhos compatíveis, a verificação do dispositivo permite desbloquear com biometria ou PIN.

## Instalação

- Android: abra o aplicativo no Chrome e toque em **Instalar**.
- iPhone: abra no Safari → **Compartilhar → Adicionar à Tela de Início**.

Abra uma vez com internet para preparar os treinos offline. Em **Ajustes**, salve ou importe um backup. Dados de outro endereço ou navegador não são transferidos automaticamente: exporte o backup no app anterior e importe no novo.

## Perfis locais

Cadastro e senha pertencem ao PeraGym neste navegador, sem conta remota ou sincronização. A senha deriva uma chave com PBKDF2; o banco guarda os treinos cifrados por perfil. A chave do perfil desbloqueado fica somente em memória. A biometria depende de WebAuthn com PRF e verificação do usuário; quando indisponível, use a senha. O aparelho pode oferecer digital, Face ID ou PIN, conforme sua configuração. O aplicativo não recebe a impressão digital.

Os treinos da versão anterior permanecem no banco original até serem trazidos explicitamente para um perfil. Guardar um backup continua necessário: apagar os dados do navegador remove também as contas locais. Não há recuperação por e-mail. O backup JSON dos treinos exportados contém dados legíveis e deve ser guardado em local privado.

## Música e Pix

A aba Música aceita links do YouTube Music e Spotify em um único player. A conexão Spotify usa OAuth PKCE e Web Playback SDK; reprodução completa exige Premium e autorização permitida pelo Spotify. A conexão Google usa autorização oficial e a API de dados do YouTube para listar playlists e vídeos disponibilizados por essa API. Isso não equivale a importar toda a biblioteca do YouTube Music nem seus recursos Premium; vídeos são reproduzidos pelo IFrame oficial quando permitem incorporação.

Para ativar as conexões, o responsável precisa preencher os **Client IDs públicos** em `pwa/web/music-config.json` e registrar as URLs do PeraGym nos painéis dos serviços. Os campos vêm vazios; o aplicativo informa quando a integração não está ativada e não apresenta conta conectada sem autorização real. Consulte [Spotify](pwa/docs/spotify-setup.md) e [Google/YouTube](pwa/docs/youtube-setup.md). Tokens ficam apenas em memória; senhas dos serviços e Client Secrets não são coletados.

A doação Pix de R$ 1,99 é opcional. O aplicativo pode ser instalado e usado sem doar. O QR Code e o Copia e Cola funcionam no site estático, sem servidor de pagamento.

## GitHub Pages

A publicação usa a configuração existente **main / raiz**. A entrada da raiz abre o site gerado em [docs/](docs/). Não há servidor, API ou banco remoto no GitHub Pages.

```sh
cd pwa
npm ci
npm test
npm run build:pages
npm run build:pages -- --check
```

Após alterar [pwa/web/](pwa/web/), gere novamente os arquivos e envie `docs/`, `index.html` e `.nojekyll` junto com as fontes. O CI confere se a publicação está atualizada; o fluxo nativo do Pages publica o commit.

Prévia local: execute `npm run dev` na raiz depois do build. O site usa `/peragym/docs/`, inclusive no manifesto e no service worker.

A implementação atual está em [pwa/](pwa/). O código Android anterior permanece no repositório como legado.
