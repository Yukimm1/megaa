# WristLink Wear con Expo

Cliente Expo/React Native para controlar la presentación desde un emulador Wear OS de Android Studio. El backend Node.js permanece en la carpeta principal. La pantalla esta optimizada para un reloj pequeño: controles grandes, estado de la sesion y acceso rapido a Wi-Fi o Bluetooth.

## Ejecutar en el emulador

1. Inicia el servidor desde una terminal:

   ```powershell
   cd C:\Users\Dell\smarth
   npm start
   ```

2. En otra terminal instala las dependencias de Expo:

   ```powershell
   cd C:\Users\Dell\smarth\expo-wear
   npm install
   ```

3. Crea o inicia un dispositivo virtual Wear OS con API 30 o superior en Android Studio.

4. Genera el proyecto Android nativo y compílalo en el emulador:

   ```powershell
   npx expo prebuild
   npx expo run:android
   ```

   También puedes abrir `C:\Users\Dell\smarth\expo-wear\android` en Android Studio y ejecutar la configuración `app`.

5. Abre el receptor en el navegador:

   ```text
   http://localhost:3000/?mode=receiver
   ```

La app usa `ws://10.0.2.2:3000/ws?role=watch`: dentro de un emulador Android, `10.0.2.2` representa el equipo anfitrión. No uses `localhost` en la app del reloj.

## Transportes

- **Wi-Fi / WebSocket** es el transporte funcional para Android Studio. El reloj virtual llega al servidor de la computadora mediante `10.0.2.2`.
- **Bluetooth / BLE** queda disponible en el panel `Connection Hub` de la app. Requiere un development build y un periférico GATT que anuncie el servicio de WristLink; Expo Go y el emulador no pueden inventar ese periférico.
- Si el enlace BLE falla, los comandos regresan automaticamente a Wi-Fi cuando el servidor WebSocket esta disponible.

### Contrato GATT para un bridge de computadora

El periférico Bluetooth debe anunciar estas UUID y traducir cada escritura de `command` a `POST /api/command` en el servidor local:

```text
Service:      4fafc201-1fb5-459e-8fcc-c5c9c331914b
Command:      4fafc202-1fb5-459e-8fcc-c5c9c331914b  (Write)
State:        4fafc203-1fb5-459e-8fcc-c5c9c331914b  (Notify)
```

La caracteristica `Command` recibe texto ASCII (`next`, `previous`, `toggle`, `laser` o `reset`). La caracteristica `State` puede notificar los mensajes JSON que ya usa el WebSocket. Este bridge es una pieza independiente para Windows; el emulador Wear OS se debe demostrar por Wi-Fi.

Si la computadora es Windows y quieres controlar una ventana real de PowerPoint o Google Slides, inicia el servidor con el puente de teclado opcional:

```powershell
$env:WRISTLINK_PRESENTATION_CONTROL = "1"
$env:WRISTLINK_PRESENTATION_WINDOW = "PowerPoint"
npm start
```

## Cambiar el servidor

Para otro equipo o una IP de la red local, define la variable antes de generar/ejecutar la app:

```powershell
$env:EXPO_PUBLIC_SERVER_URL = "ws://192.168.1.20:3000/ws?role=watch"
npx expo run:android
```

El servidor debe aceptar conexiones entrantes en el puerto 3000.

## Notas

- Esta app necesita un development build nativo; Expo Go no es adecuado para instalarla como app Wear OS.
- El plugin `plugins/withWearOs.js` agrega `android.hardware.type.watch` al manifest generado.
- `npx expo prebuild --clean` regenera `android` cuando cambies la configuración nativa.
- Los botones funcionan en el emulador. La lectura de la corona rotatoria requiere un modulo nativo adicional; la implementación nativa original en `android-wear` conserva esa funcion y la pantalla Expo deja visible la indicacion de la corona.
- Para cambiar de transporte, toca la pastilla de estado en la parte superior del reloj.
