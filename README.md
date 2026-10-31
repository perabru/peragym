# PeraGym

Aplicativo Android de fichas de treino com **banco SQLite local**, sem cadastro e sem depender de internet. Identidade visual em coral, amarelo e vinho, adaptada dos cards enviados como referência.

## Instalar

**[Baixar PeraGym 1.0.0 para Android](https://github.com/perabru/peragym/raw/refs/heads/main/downloads/PeraGym-1.0.0.apk)**

Requer Android 8.0 ou superior. Abra o APK no celular e permita a instalação pelo aplicativo utilizado para baixar o arquivo, caso o Android solicite. Esta versão usa assinatura de desenvolvimento para instalação direta.

## Recursos

- Criar, editar e excluir fichas de treino, com confirmação antes de excluir.
- Adicionar e remover exercícios; registrar séries, repetições, descanso e observações.
- Ajustar cargas em quilos, inclusive valores como **12,5 kg**; botões rápidos de −1 kg e +1 kg.
- Tela de loading animada, inspirada no indicador de pulso fornecido.
- Tema claro e escuro com toggle de sol/lua e preferência salva no aparelho.
- Busca por nome da ficha e foco muscular.
- Cronômetro de treino, marcação de exercícios concluídos e temporizador de descanso.
- Histórico de treinos concluídos e acompanhamento da semana.

O aplicativo começa sem fichas ou resultados fictícios. Na primeira abertura, toque em **Criar minha primeira ficha**, preencha os exercícios e salve. Toque no valor da carga para informar um peso exato. Os ajustes são salvos automaticamente.

## Dados locais

As fichas, exercícios e sessões ficam em `peragym.db`, no armazenamento privado do aplicativo. A preferência de tema fica em SharedPreferences. Nenhuma permissão de internet, conta, anúncio ou serviço remoto é utilizado.

Excluir uma ficha remove seus exercícios e mantém os treinos já concluídos no histórico. Desinstalar o aplicativo ou apagar seus dados nas configurações do Android remove o banco local. O backup automático do Android está desativado.

## Código e compilação

Projeto Java com Activity Android, interface HTML/CSS/JavaScript empacotada no APK e SQLiteOpenHelper. O WebView só carrega os arquivos internos do aplicativo. O banco Android não usa localStorage; o adaptador de localStorage existe apenas para prévia e testes da interface no navegador.

- Android: `app/src/main/java/br/com/peragym/`
- Interface: `app/src/main/assets/`
- Testes SQLite no Android: `app/src/androidTest/`
- Testes de interface: `tests/ui.test.cjs`
- APK e checksum: `downloads/`

Com JDK 17 e Android SDK 35 instalados:

```sh
./gradlew assembleDebug assembleDebugAndroidTest lintDebug
```

Para executar os testes SQLite em um emulador ou aparelho de testes conectado:

```sh
./gradlew connectedDebugAndroidTest
```

Para testar a interface com Node.js instalado:

```sh
npm install
npx playwright install chromium
npm run test:ui
```

Os testes executam os fluxos de criação, edição e exclusão de fichas, cargas decimais, tema persistente, busca, sessões e histórico. Também verificam ausência de rolagem horizontal em telas de 360 × 800 e 1280 × 900. As capturas de verificação ficam na pasta temporária do sistema.

Consulte [tools/BUILD.md](tools/BUILD.md) para instruções completas. O GitHub Actions compila o aplicativo, executa o Android Lint e testa o banco de dados em um emulador. Os artefatos produzidos pelo CI podem usar uma assinatura diferente do APK fornecido em `downloads/`; para atualizações que preservem os dados, mantenha a mesma chave de assinatura.

## Referências visuais

Adaptações dos arquivos enviados: cards de KSAplay (paleta, paisagem e formas), botão de Voxybuns, toggle de JkHuger e loading de milley69, identificados nos arquivos como referências do Uiverse.io. Interface e lógica foram desenvolvidas para o PeraGym. Os anexos de música e Tinkercad não são dependências do aplicativo.
