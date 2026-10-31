# PeraGym PWA — Vice Training

**[Abrir PeraGym](https://peragym-treino.perabru.chatgpt.site/)**

Aplicativo gratuito em HTML, CSS e JavaScript, instalável no Android e no iPhone. Identidade retrô tropical, com neon rosa e ciano, céu roxo, palmeiras e botões de salvar com fita cassete. Fichas, exercícios, cargas, histórico e peso corporal ficam no IndexedDB do próprio aparelho.

## Baixar e instalar gratuitamente

Toque em **Baixar grátis** na página promocional. Antes da instalação, aparece um convite para apoiar o projeto com um **Pix opcional de R$ 1,99** para `bruno.pera@unifesp.br`, com QR Code e Pix Copia e Cola.

Você pode escolher **Continuar sem doar e instalar**. A doação nunca condiciona o acesso: não há compra, cadastro, login, comprovante, licença ou conferência bancária para usar o app. O acesso direto a `/app/` e `/download` também é gratuito.

- **Android:** abra no Chrome e use **Instalar aplicativo**, ou a opção equivalente no menu.
- **iPhone/iPad:** abra no Safari e use **Compartilhar → Adicionar à Tela de Início → Adicionar**.

A instalação é confirmada no próprio celular. Abra o app com internet uma vez para preparar o uso offline. No iOS, o armazenamento do app instalado pode ser separado do navegador; comece seus registros pelo ícone instalado e use o backup antes de trocar de dispositivo ou apagar os dados do site.

## Recursos

- Criar, editar e excluir fichas e exercícios.
- Ajustar cargas em kg, incluindo valores decimais.
- Séries, repetições, descanso e observações.
- Loading animado e tema claro/escuro.
- Cronômetro, descanso e histórico dos treinos.
- Gráficos de evolução das cargas por exercício e do peso corporal, com tabelas e filtros.
- Backup JSON local com importação validada e atômica.

O app começa vazio. As prévias da página promocional são identificadas como ilustrações. Não há sincronização automática entre aparelhos nem envio dos registros de treino ou peso ao servidor.

## Implementação

`web/index.html` é a página promocional. `web/app/` contém o aplicativo e o IndexedDB. `web/sw.js` prepara o cache offline gratuito. `server/worker.js` serve os arquivos públicos e gera o QR Code Pix fixo de R$ 1,99.

O QR usa o formato BR Code e CRC do Pix. Ele apresenta uma doação sugerida e não cria um pedido nem confirma uma transferência. Uma falha ao gerar o QR não impede abrir o aplicativo.

O fluxo de compras anterior foi desativado e os antigos endpoints de pedidos retornam HTTP 410. As tabelas históricas foram preservadas sem leitura, alteração ou exclusão. A versão gratuita não depende desse banco remoto, de cookies de acesso nem de autenticação.

## Desenvolvimento

Requer Node.js 24 ou superior.

```sh
npm ci
npm test
npm run build
npm run validate
npm run dev
```

Os testes usam bancos locais isolados e não fazem pagamentos reais. `scripts/embed-assets.mjs` incorpora os arquivos em um Worker ESM. A hospedagem usa HTTPS para permitir a instalação do PWA e o service worker. Os arquivos de `web/app/` também são fontes HTML/CSS/JS comuns, sem dependências externas no navegador.

Os arquivos de migração em `drizzle/` são históricos e permanecem imutáveis. O build exclui testes dos recursos servidos ao visitante.

## Referências visuais

Visual inspirado nas referências de cidade tropical neon e fita cassete enviadas pelo usuário. PeraGym mantém identidade própria; não utiliza o logotipo GTA como marca do aplicativo. A fotografia `night-drive.jpg` foi fornecida pelo usuário. Fontes locais Bungee (OFL) e Yellowtail (Apache 2.0), com seus textos de licença em `web/assets/fonts/`. O ícone de salvar é uma fita cassete em SVG. QR Code gerado com `qrcode-generator`.

## Música no aplicativo

A aba Música carrega links de vídeos e playlists públicas do YouTube e YouTube Music no player oficial do YouTube. Os oito links recentes ficam no IndexedDB e no backup. O player permanece visível ao navegar pelas fichas; fecha pelo botão × e pausa quando o aplicativo perde visibilidade ou um formulário cobre a tela. Música requer internet e disponibilidade de incorporação pelo autor.

A conta é acessada pelo link para o site oficial do YouTube Music. O PeraGym não coleta login/senha, não afirma uma conexão OAuth e não importa bibliotecas privadas ou recursos Premium. O player IFrame não fornece autenticação de conta do YouTube Music.

Documentação: [player IFrame](https://developers.google.com/youtube/iframe_api_reference), [requisitos de incorporação](https://developers.google.com/youtube/terms/required-minimum-functionality), [políticas de autenticação](https://developers.google.com/youtube/terms/developer-policies).
