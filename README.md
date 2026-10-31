# PeraGym PWA — Vice Training 3.1.0

**[Abrir o PeraGym e instalar grátis](https://peragym-treino.perabru.chatgpt.site/)**

Aplicativo gratuito em HTML, CSS e JavaScript, instalável como PWA no Android e no iOS, com banco IndexedDB local, fichas de treino e gráficos de evolução de cargas e peso corporal.

A versão **3.1.0 — Vice Training** traz textos mais curtos e visual retrô tropical, neon rosa e ciano, atmosfera roxa, palmeiras, fontes locais Bungee e Yellowtail e botões de salvar com fita cassete. A identidade é própria do PeraGym.

## Doação opcional

Antes de instalar, a página oferece um QR Code e Pix Copia e Cola para uma **doação sugerida de R$ 1,99** à chave `bruno.pera@unifesp.br`.

O botão **Continuar sem doar e instalar** fica sempre disponível. O aplicativo é gratuito, sem cadastro, login, compra, comprovante ou confirmação de pagamento. A doação não condiciona o acesso ao aplicativo. `/app/` e `/download` são públicos.

## Instalar

- **Android:** Chrome → Instalar aplicativo.
- **iPhone:** Safari → Compartilhar → Adicionar à Tela de Início.

A instalação precisa ser confirmada no próprio aparelho. Abra o app uma vez com internet para preparar o uso offline. Os registros ficam no aparelho; use o backup local antes de trocar de navegador, aparelho ou apagar os dados do site.

## Música

A aba **Música** aceita links de vídeos e playlists públicas do YouTube e YouTube Music no player oficial do YouTube. Os **oito links recentes** ficam no IndexedDB e no backup local.

O player permanece visível durante a navegação pelas fichas e pausa quando o app perde visibilidade ou um formulário cobre a tela. A música requer internet e permissão de incorporação pelo autor; os treinos continuam disponíveis offline.

O botão para acessar a conta abre o **site oficial do YouTube Music para login externo**. O PeraGym não integra OAuth, não coleta senha e não importa biblioteca privada nem recursos Premium. Mais detalhes e referências estão em [pwa/README.md](pwa/README.md).

## Código

A implementação atual está em [pwa/](pwa/). A página promocional é [pwa/web/index.html](pwa/web/index.html), e o app está em [pwa/web/app/](pwa/web/app/).

```sh
cd pwa
npm ci
npm test
npm run build
npm run validate
```

Os **49 testes** cobrem acesso gratuito, Pix opcional de R$ 1,99, migração do cache offline, IndexedDB, gráficos, backup, links de música, histórico recente e integridade dos recursos visuais e fontes locais. O fluxo de compras foi desativado; as antigas tabelas foram preservadas sem alteração. O app gratuito funciona sem o banco remoto ou cookies de licença.

Consulte [pwa/README.md](pwa/README.md). O código Android anterior permanece no repositório e no histórico como versão anterior.
