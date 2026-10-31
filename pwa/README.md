# PeraGym PWA

Aplicativo em **HTML, CSS e JavaScript** para Android, iPhone e navegador. Fichas, exercícios, cargas e peso corporal ficam no **IndexedDB do próprio aparelho**. A versão web substitui o APK na distribuição principal.

## Páginas

- `/`: página promocional (`web/index.html`), com o visual coral, amarelo e vinho do PeraGym.
- `/app/`: aplicativo, acessível após a liberação da compra; o responsável também pode abri-lo pela sua conta.
- `/admin/`: administração exclusiva do responsável.
- `/download`: abre a instalação do aplicativo após validar o acesso no servidor.

## Aplicativo

Criar, editar e excluir fichas e exercícios; cargas em quilos com casas decimais; séries, repetições, descanso e observações; loading animado; tema claro/escuro; cronômetro e histórico; gráficos de cargas por exercício e registros de peso corporal; tabelas com os pontos dos gráficos; filtros por período; backup JSON local com importação validada e atômica.

O aplicativo começa vazio. As imagens e os números na página promocional estão identificados como exemplos ilustrativos. Nenhum gráfico do aplicativo inventa medições.

## Pix e liberação

A chave configurada é `bruno.pera@unifesp.br`. Cada pedido recebe valor fixado no servidor, identificador, código Pix Copia e Cola e QR Code.

**A confirmação é manual.** A chave Pix, sozinha, não informa ao sistema se o dinheiro chegou. O responsável confere o recebimento no extrato bancário, entra em `/admin/`, registra a referência da transação e libera o pedido. A referência não pode ser usada para aprovar dois pedidos. Comprovantes enviados ou um botão “já paguei” não liberam o aplicativo.

As vendas começam pausadas, pois o preço não foi informado. Para ativar:

1. Entre em `/admin/` com a conta ChatGPT do responsável.
2. Defina o preço único e marque a abertura das vendas.
3. Confira cada Pix no banco antes de aprovar o pedido.

O cliente guarda seu **arquivo de acesso do pedido**, que contém uma chave privada de recuperação. Depois da confirmação, o servidor emite um cookie `HttpOnly`, `Secure` e `SameSite=Lax`. Sem compra confirmada, os arquivos do aplicativo são bloqueados no servidor, mesmo que alguém altere flags no navegador. Tokens são armazenados como hashes. Pedidos e dados administrativos nunca entram no cache offline.

O preço enviado pelo cliente é ignorado. O código não processa cartões nem utiliza a conta Stripe de outro projeto. Para automatizar a confirmação no futuro, será necessária uma API do banco/provedor com consulta de transações e webhook autenticado. Não há uma simulação de confirmação automática nesta versão.

O código-fonte publicado no GitHub pode ser estudado e copiado; a proteção controla a distribuição no serviço hospedado. A versão Android disponibilizada anteriormente continua no histórico Git, e seus links antigos não podem ser recolhidos por este controle de acesso do PWA.

## Instalar

Após liberar o acesso, abra `/app/` com internet e aguarde a indicação de que o uso offline está pronto.

- **Android:** abra no Chrome e use **Instalar aplicativo** ou a opção correspondente no menu.
- **iPhone/iPad:** abra no Safari, toque em **Compartilhar → Adicionar à Tela de Início → Adicionar**.

A instalação precisa ser confirmada no aparelho. O site não instala um aplicativo silenciosamente nem depende da Play Store/App Store.

No iOS, o aplicativo instalado pode usar um armazenamento separado do navegador. Guarde o arquivo de acesso do pedido para restaurar a compra caso seja solicitado, e comece a registrar seus treinos dentro do app instalado. Os registros não sincronizam entre aparelhos. Use o backup antes de trocar de dispositivo, navegador ou apagar os dados do site.

## Dados e servidor

Os dados pessoais de treino e peso permanecem no IndexedDB. O servidor armazena apenas a configuração de venda, pedidos, contato do comprador, confirmação e licenças em D1. Não há publicidade ou rastreadores.

A autenticação administrativa usa a identidade fornecida pela plataforma Sites. `ADMIN_EMAIL` fica na configuração privada do serviço e permite vincular, uma única vez, o identificador estável da conta do responsável. O site público não recebe essa configuração no JavaScript do cliente.

## Desenvolvimento

Requer Node.js 24 ou superior.

```sh
npm ci
npm test
npm run build
npm run validate
npm run dev
```

A prévia local aplica as migrações em `.sites-runtime/preview.sqlite`, separado da produção. Ela não simula login de administrador. Testes usam bancos isolados e não criam vendas reais.

Estrutura:

```text
web/index.html          Página promocional
web/app/                Aplicativo e banco local
web/admin/              Administração
web/sw.js               Cache offline protegido
server/worker.js        Pedidos, Pix e controle de acesso
db/schema.ts            Esquema de compras
drizzle/                Migrações geradas e metadados
scripts/embed-assets.mjs  Incorpora os arquivos no Worker
```

O build incorpora os arquivos do app dentro do Worker, em vez de publicá-los como arquivos estáticos sem autenticação. O projeto precisa de HTTPS e de um backend com D1 e autenticação Sites; apenas hospedagem estática como GitHub Pages não executa a verificação de pagamentos.

Para mudar o esquema, altere `db/schema.ts`, execute `npm run db:generate`, revise e preserve as migrações aplicadas. O fluxo Sites aplica as migrações hospedadas antes de publicar.

## Referências

Identidade visual adaptada dos cards e exemplos enviados pelo usuário (KSAplay, Voxybuns, JkHuger e milley69/Uiverse). QR Code gerado com `qrcode-generator`. Formato Pix e CRC implementados conforme o manual de padrões do Banco Central.
