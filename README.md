# PeraGym

Aplicativo em **HTML, CSS e JavaScript**, instalável como **PWA no Android e no iOS**, com banco IndexedDB local e gráficos de evolução de cargas e de peso corporal.

**[Abrir página promocional e PeraGym](https://peragym-treino.perabru.chatgpt.site/)**

A implementação atual está em [pwa/](pwa/). A página promocional é [pwa/web/index.html](pwa/web/index.html), e o aplicativo fica em [pwa/web/app/](pwa/web/app/).

Inclui fichas/exercícios editáveis, cargas decimais em kg, loading, tema claro/escuro, cronômetros, histórico, gráficos SVG e backup local.

## Compra com Pix

A chave é `bruno.pera@unifesp.br`. Os arquivos do PWA são protegidos pelo servidor e liberados após confirmação manual do recebimento no banco. O responsável define o preço e confere os pedidos na área administrativa do site, acessada com sua conta ChatGPT. A chave Pix sozinha não confirma pagamentos automaticamente.

**As vendas começam pausadas até que o preço seja definido no painel.** Há QR Code, Pix Copia e Cola, token privado de recuperação e bloqueio de download antes da aprovação.

## Instalação

Após liberar o acesso, abra o aplicativo no celular:

- Android/Chrome: **Instalar aplicativo**.
- iOS/Safari: **Compartilhar → Adicionar à Tela de Início**.

A instalação é confirmada no próprio aparelho. Treinos e peso não sincronizam entre dispositivos; use o backup local ao trocar de navegador/aparelho.

## Código e testes

```sh
cd pwa
npm ci
npm test
npm run build
npm run validate
```

Os 26 testes cobrem IndexedDB, backup, gráficos, uso offline e controle de pagamento. A implementação hospedada usa Worker/D1 para os pedidos e a identidade Sites para administrar. Hospedagem puramente estática não verifica recebimentos nem protege os downloads. Consulte [pwa/README.md](pwa/README.md).

O código Android original é mantido como versão anterior. O APK foi retirado da distribuição principal deste repositório; arquivos e links publicados em commits anteriores continuam no histórico Git. O controle de acesso se aplica à nova versão PWA.
