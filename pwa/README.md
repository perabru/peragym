# PeraGym — PWA

HTML, CSS e JavaScript com IndexedDB local. A publicação atual é [GitHub Pages](https://perabru.github.io/peragym/).

## Recursos

- Criar, editar e excluir fichas; registrar séries, repetições, cargas e descanso.
- Histórico de treinos e gráficos de cargas e peso corporal.
- Temas claro e escuro, instalação Android/iPhone e treinos offline.
- Backup JSON dos registros e dos oito links recentes de música.
- Player oficial do YouTube para links públicos; acesso à conta no site do YouTube Music.
- Pix opcional de R$ 1,99, sem bloqueio para instalar ou usar.

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

## Música

Links de vídeos e playlists públicas são validados antes de carregar o IFrame oficial. O player fica visível, pausa quando o aplicativo é ocultado ou um formulário cobre a tela e oferece abertura externa quando o conteúdo não permite incorporação. Não há coleta de credenciais Google, OAuth de conta, biblioteca privada ou reprodução Premium em segundo plano.

Referências: [IFrame](https://developers.google.com/youtube/iframe_api_reference) e [políticas](https://developers.google.com/youtube/terms/developer-policies).

## Recursos visuais

Cassete e palmeiras em SVG originais. Imagem de referência fornecida pelo usuário em `web/assets/night-drive.jpg`. Fontes locais Bungee (OFL) e Yellowtail (Apache 2.0), com licenças em `web/assets/fonts/`.
