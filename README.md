# PeraGym 3.3

**[Abrir o site](https://perabru.github.io/peragym/) · [Abrir o aplicativo](https://perabru.github.io/peragym/docs/app/)**

PWA gratuito para Android e iPhone. Fichas de treino, cargas em quilos, peso corporal, gráficos e histórico no banco local do aparelho. Visual neon e fita cassete nos botões de salvar.

A abertura mostra uma tela de carregamento com recuperação de falhas. O site e a tela inicial do app foram simplificados; instalar abre diretamente o aplicativo e o guia do aparelho.

## Instalação

- Android: abra o aplicativo no Chrome e toque em **Instalar**.
- iPhone: abra no Safari → **Compartilhar → Adicionar à Tela de Início**.

Abra uma vez com internet para preparar os treinos offline. Em **Ajustes**, salve ou importe um backup. Dados de outro endereço ou navegador não são transferidos automaticamente: exporte o backup no app anterior e importe no novo.

## Música e Pix

A aba Música aceita links do YouTube Music e Spotify em um único player. O YouTube continua com o player oficial e acesso externo à conta; não importa biblioteca privada. O Spotify dispõe de autorização OAuth PKCE com retorno ao PeraGym e engine Web Playback SDK: para ativar contas, é necessário configurar o Client ID público e o callback da aplicação Spotify. O arquivo padrão vem vazio; a interface não simula uma conta conectada. Consulte [ativação Spotify](pwa/docs/spotify-setup.md). Streaming completo pelo SDK requer Premium e as permissões e limites vigentes do Spotify. Nenhuma senha ou Client Secret é coletado.

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
