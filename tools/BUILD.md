# Compilar o PeraGym

Requisitos: JDK 17, Android SDK com a plataforma 35 e Build Tools 35.0.0.
Abra a raiz do projeto no Android Studio ou defina `ANDROID_HOME` para seu SDK.

No Linux ou macOS:

```sh
./gradlew assembleDebug lintDebug
```

No Windows:

```bat
gradlew.bat assembleDebug lintDebug
```

O APK fica em `app/build/outputs/apk/debug/app-debug.apk` e pode ser instalado
em Android 8.0 ou superior. Ele utiliza assinatura de desenvolvimento.
Não é necessária uma conta e o aplicativo não solicita acesso à internet.

Para executar os testes reais de SQLite, conecte um aparelho de testes ou inicie
um emulador e execute:

```sh
./gradlew connectedDebugAndroidTest
```

A automação em `.github/workflows/android.yml` compila, executa o Android Lint,
compila os testes e disponibiliza um APK de desenvolvimento nos artefatos da
execução. Um segundo job executa os testes de banco em um emulador Android 35.
O APK de instalação direta está em `downloads/PeraGym-1.0.0.apk` no repositório.
As compilações automáticas podem usar uma chave de desenvolvimento diferente da
versão de instalação direta. Nesse caso o Android exige desinstalar a versão
anterior antes de instalar o novo APK. A desinstalação apaga o banco local.

Para distribuição pela Play Store, configure sua própria chave de produção
fora do repositório e ajuste a versão; nenhuma chave privada faz parte do código.
