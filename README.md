# PeraGym 3.2

**[Abrir o site](https://perabru.github.io/peragym/) · [Abrir o aplicativo](https://perabru.github.io/peragym/docs/app/)**

PWA gratuito para Android e iPhone. Fichas de treino, cargas em quilos, peso corporal, gráficos e histórico no banco local do aparelho. Visual neon e fita cassete nos botões de salvar.

## Instalação

- Android: abra o aplicativo no Chrome e toque em **Instalar**.
- iPhone: abra no Safari → **Compartilhar → Adicionar à Tela de Início**.

Abra uma vez com internet para preparar os treinos offline. Em **Ajustes**, salve ou importe um backup. Dados de outro endereço ou navegador não são transferidos automaticamente: exporte o backup no app anterior e importe no novo.

## Música e Pix

A aba Música carrega links públicos no player oficial do YouTube. Precisa de internet e permissão de incorporação do conteúdo. O acesso à conta abre no YouTube Music; o PeraGym não coleta senha ou importa biblioteca privada.

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
