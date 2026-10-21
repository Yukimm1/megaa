import Constants from 'expo-constants';
import {
  ActivityIndicator,
  Modal,
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
  useWindowDimensions
} from 'react-native';
import { useEffect, useRef, useState } from 'react';

const DEFAULT_SERVER_URL = 'ws://10.0.2.2:3000/ws?role=watch';
const RECONNECT_DELAY_MS = 3000;
const BLE_SERVICE_UUID = '4fafc201-1fb5-459e-8fcc-c5c9c331914b';
const BLE_COMMAND_UUID = '4fafc202-1fb5-459e-8fcc-c5c9c331914b';
const BLE_STATE_UUID = '4fafc203-1fb5-459e-8fcc-c5c9c331914b';

const EMPTY_STATE = {
  currentSlide: 1,
  totalSlides: 8,
  isPlaying: true,
  laserVisible: false,
  lastCommand: { label: 'Esperando presentacion' },
  slides: []
};

const colors = {
  background: '#071117',
  backgroundRaised: '#0B1921',
  card: '#10232D',
  cardSoft: '#142B36',
  line: '#24404C',
  primary: '#B8F36B',
  secondary: '#71E6F4',
  violet: '#A78BFA',
  text: '#F2F7F1',
  muted: '#8EA6AD',
  mutedDark: '#58717A',
  danger: '#FF8C8C',
  ink: '#071117'
};

let bleManagerInstance;

function getBleManager() {
  if (bleManagerInstance) return bleManagerInstance;

  try {
    const module = require('react-native-ble-manager');
    bleManagerInstance = module.default || module;
    return bleManagerInstance;
  } catch {
    return null;
  }
}

function getServerUrl() {
  return (
    process.env.EXPO_PUBLIC_SERVER_URL ||
    Constants.expoConfig?.extra?.serverUrl ||
    DEFAULT_SERVER_URL
  );
}

function formatTime(date = new Date()) {
  return date.toLocaleTimeString('es-MX', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

function getErrorMessage(error) {
  return error?.message || String(error || 'Error desconocido');
}

function encodeCommand(command) {
  return Array.from(command).map((character) => character.charCodeAt(0));
}

function decodeBytes(bytes) {
  return String.fromCharCode(...bytes);
}

async function requestBluetoothPermissions() {
  if (Platform.OS !== 'android') return true;

  if (Platform.Version >= 31) {
    const scanPermission =
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN || 'android.permission.BLUETOOTH_SCAN';
    const connectPermission =
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT || 'android.permission.BLUETOOTH_CONNECT';
    const result = await PermissionsAndroid.requestMultiple([scanPermission, connectPermission]);
    return Object.values(result).every((value) => value === PermissionsAndroid.RESULTS.GRANTED);
  }

  const locationPermission = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
  );
  return locationPermission === PermissionsAndroid.RESULTS.GRANTED;
}

function getPeripheralName(peripheral) {
  return peripheral?.name || peripheral?.advertising?.localName || 'WristLink Bridge';
}

export default function App() {
  const { width, height } = useWindowDimensions();
  const compact = width <= 400 && height <= 400;
  const serverUrl = getServerUrl();
  const socketRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const activeTransportRef = useRef('wifi');
  const blePeripheralRef = useRef(null);

  const [clock, setClock] = useState(formatTime());
  const [state, setState] = useState(EMPTY_STATE);
  const [action, setAction] = useState('Listo para conectar');
  const [wifiStatus, setWifiStatus] = useState('connecting');
  const [activeTransport, setActiveTransport] = useState('wifi');
  const [showConnection, setShowConnection] = useState(false);
  const [bleStatus, setBleStatus] = useState('idle');
  const [bleDevices, setBleDevices] = useState([]);
  const [bleMessage, setBleMessage] = useState('Busca un WristLink Bridge cercano.');

  const updatePresentationState = (nextState) => {
    if (!nextState) return;
    setState((previousState) => ({ ...previousState, ...nextState }));
    if (nextState.lastCommand?.label) {
      setAction(nextState.lastCommand.label);
    }
  };

  useEffect(() => {
    const timer = setInterval(() => setClock(formatTime()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const manager = getBleManager();
    if (!manager) {
      setBleMessage('Bluetooth requiere un development build nativo.');
      return undefined;
    }

    let subscriptions = [];

    try {
      subscriptions = [
        manager.onDiscoverPeripheral((peripheral) => {
          setBleDevices((previousDevices) => {
            const alreadyAdded = previousDevices.some((device) => device.id === peripheral.id);
            return alreadyAdded ? previousDevices : [...previousDevices, peripheral];
          });
        }),
        manager.onStopScan(() => {
          setBleStatus((previousStatus) => (previousStatus === 'scanning' ? 'idle' : previousStatus));
          setBleMessage((previousMessage) =>
            previousMessage === 'Buscando dispositivos...' ? 'No se encontro un bridge compatible.' : previousMessage
          );
        }),
        manager.onDidUpdateState(({ state: bluetoothState }) => {
          if (bluetoothState === 'off') {
            setBleStatus('idle');
            setBleMessage('Activa Bluetooth en el reloj para buscar.');
          }
        }),
        manager.onDisconnectPeripheral(({ peripheral }) => {
          if (peripheral !== blePeripheralRef.current) return;
          blePeripheralRef.current = null;
          activeTransportRef.current = 'wifi';
          setActiveTransport('wifi');
          setBleStatus('idle');
          setBleMessage('Bluetooth se desconecto. Wi-Fi queda disponible.');
          setAction('Bluetooth desconectado');
        }),
        manager.onDidUpdateValueForCharacteristic((event) => {
          if (
            event.peripheral !== blePeripheralRef.current ||
            String(event.service || '').toLowerCase() !== BLE_SERVICE_UUID ||
            String(event.characteristic || '').toLowerCase() !== BLE_STATE_UUID
          ) {
            return;
          }

          try {
            const message = JSON.parse(decodeBytes(event.value));
            if (message.type === 'state') updatePresentationState(message.data);
            if (message.type === 'command') updatePresentationState(message.data?.state);
          } catch {
            setAction('Estado Bluetooth no valido');
          }
        })
      ];
    } catch {
      setBleMessage('Bluetooth no esta disponible en este dispositivo.');
    }

    return () => {
      subscriptions.forEach((subscription) => subscription?.remove?.());
    };
  }, []);

  useEffect(() => {
    let active = true;

    const handleMessage = (rawMessage) => {
      try {
        const message = JSON.parse(rawMessage);

        if (message.type === 'state') {
          updatePresentationState(message.data);
          return;
        }

        if (message.type === 'command') {
          updatePresentationState(message.data?.state);
          if (message.data?.label) setAction(message.data.label);
          return;
        }

        if (message.type === 'error') setAction(message.error || 'Error del servidor');
      } catch {
        setAction('Respuesta invalida');
      }
    };

    const connect = () => {
      if (!active) return;

      setWifiStatus('connecting');
      const socket = new WebSocket(serverUrl);
      socketRef.current = socket;

      socket.onopen = () => {
        if (!active) return;
        setWifiStatus('connected');
        if (activeTransportRef.current === 'wifi') setAction('Wi-Fi conectado');
        socket.send(JSON.stringify({ type: 'state' }));
      };

      socket.onmessage = (event) => handleMessage(event.data);

      socket.onerror = () => {
        if (active) setWifiStatus('error');
      };

      socket.onclose = () => {
        if (!active) return;
        socketRef.current = null;
        setWifiStatus('offline');
        if (activeTransportRef.current === 'wifi') setAction('Reintentando Wi-Fi...');
        reconnectTimerRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
      };
    };

    connect();

    return () => {
      active = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (socketRef.current) socketRef.current.close();
      socketRef.current = null;
    };
  }, [serverUrl]);

  const sendWifiCommand = (command) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== 1) {
      setAction('Sin conexion Wi-Fi');
      return false;
    }

    socket.send(
      JSON.stringify({
        type: 'command',
        command,
        source: 'expo-wear'
      })
    );
    return true;
  };

  const sendBluetoothCommand = async (command) => {
    const manager = getBleManager();
    const peripheralId = blePeripheralRef.current;

    if (!manager || !peripheralId) {
      setAction('Bluetooth no conectado');
      return false;
    }

    try {
      await manager.write(
        peripheralId,
        BLE_SERVICE_UUID,
        BLE_COMMAND_UUID,
        encodeCommand(command),
        20
      );
      setAction(`Bluetooth / ${command}`);
      return true;
    } catch {
      setAction('Bluetooth fallo; usando Wi-Fi');
      activeTransportRef.current = 'wifi';
      setActiveTransport('wifi');
      return sendWifiCommand(command);
    }
  };

  const sendCommand = (command) => {
    if (activeTransportRef.current === 'bluetooth' && blePeripheralRef.current) {
      sendBluetoothCommand(command);
      return;
    }

    sendWifiCommand(command);
  };

  const scanBluetooth = async () => {
    const manager = getBleManager();
    if (!manager) {
      setBleMessage('Instala y ejecuta un development build para usar Bluetooth.');
      return;
    }

    const hasPermission = await requestBluetoothPermissions();
    if (!hasPermission) {
      setBleMessage('Permiso Bluetooth denegado.');
      setBleStatus('error');
      return;
    }

    try {
      await manager.start({ showAlert: false });
      setBleDevices([]);
      setBleStatus('scanning');
      setBleMessage('Buscando dispositivos...');
      await manager.scan({
        serviceUUIDs: [BLE_SERVICE_UUID],
        seconds: 7,
        allowDuplicates: false
      });
    } catch (error) {
      setBleStatus('error');
      setBleMessage(getErrorMessage(error));
    }
  };

  const connectBluetooth = async (peripheral) => {
    const manager = getBleManager();
    if (!manager) return;

    try {
      if (await manager.isScanning()) await manager.stopScan();
      setBleStatus('connecting');
      setBleMessage(`Conectando a ${getPeripheralName(peripheral)}...`);
      await manager.connect(peripheral.id);
      await manager.retrieveServices(peripheral.id, [BLE_SERVICE_UUID]);
      await manager.startNotification(peripheral.id, BLE_SERVICE_UUID, BLE_STATE_UUID);
      blePeripheralRef.current = peripheral.id;
      activeTransportRef.current = 'bluetooth';
      setActiveTransport('bluetooth');
      setBleStatus('connected');
      setBleMessage(`${getPeripheralName(peripheral)} conectado.`);
      setAction('Bluetooth conectado');
    } catch (error) {
      setBleStatus('error');
      setBleMessage(`No se pudo conectar: ${getErrorMessage(error)}`);
    }
  };

  const disconnectBluetooth = async () => {
    const manager = getBleManager();
    const peripheralId = blePeripheralRef.current;
    if (!manager || !peripheralId) return;

    try {
      await manager.disconnect(peripheralId);
    } catch {
      // The connection may already be gone; reset the local transport anyway.
    }
    blePeripheralRef.current = null;
    activeTransportRef.current = 'wifi';
    setActiveTransport('wifi');
    setBleStatus('idle');
    setBleMessage('Bluetooth desconectado.');
  };

  const selectWifi = () => {
    activeTransportRef.current = 'wifi';
    setActiveTransport('wifi');
    setAction(wifiStatus === 'connected' ? 'Wi-Fi seleccionado' : 'Esperando Wi-Fi');
    setShowConnection(false);
  };

  const currentSlide = Math.min(Math.max(Number(state.currentSlide) || 1, 1), state.totalSlides || 8);
  const totalSlides = state.totalSlides || 8;
  const currentSlideData = state.slides?.[currentSlide - 1];
  const slideTitle = currentSlideData?.title || 'Presentaciones\nsin cables';
  const slideSection = currentSlideData?.section || 'Sesion en vivo';
  const progress = `${Math.round((currentSlide / totalSlides) * 100)}%`;
  const bleConnected = bleStatus === 'connected' && Boolean(blePeripheralRef.current);
  const connectionLabel =
    activeTransport === 'bluetooth'
      ? bleConnected
        ? 'BT / LINK'
        : 'BT / OFFLINE'
      : wifiStatus === 'connected'
        ? 'WI-FI / LINK'
        : wifiStatus === 'connecting'
          ? 'WI-FI / ...'
          : 'WI-FI / OFFLINE';
  const isConnected = activeTransport === 'bluetooth' ? bleConnected : wifiStatus === 'connected';
  const connectionColor = isConnected ? colors.primary : wifiStatus === 'error' ? colors.danger : colors.muted;
  const visibleConnectionLabel = compact
    ? activeTransport === 'bluetooth'
      ? bleConnected
        ? 'BT LINK'
        : 'BT OFF'
      : wifiStatus === 'connected'
        ? 'WI-FI'
        : 'WI-FI ...'
    : connectionLabel;

  return (
    <View style={styles.safeArea}>
      <StatusBar barStyle="light-content" backgroundColor={colors.background} />
      <View style={styles.screenGlow} />
      <View style={[styles.container, compact && styles.containerCompact]}>
        <View style={[styles.topbar, compact && styles.topbarCompact]}>
          <View style={[styles.brandBlock, compact && styles.brandBlockCompact]}>
            <View style={[styles.brandMark, compact && styles.brandMarkCompact]}>
              <Text style={[styles.brandMarkText, compact && styles.brandMarkTextCompact]}>W</Text>
            </View>
            <View>
              <Text style={[styles.brand, compact && styles.brandCompact]} numberOfLines={1}>WRISTLINK</Text>
              <Text style={[styles.brandSub, compact && styles.brandSubCompact]} numberOfLines={1}>REMOTE DECK / 01</Text>
            </View>
          </View>

          <Pressable
            accessibilityLabel="Abrir conexiones"
            onPress={() => setShowConnection(true)}
            style={({ pressed }) => [styles.connectionPill, compact && styles.connectionPillCompact, pressed && styles.pressed]}
          >
            <View style={[styles.connectionDot, { backgroundColor: connectionColor }]} />
            <Text style={[styles.connectionLabel, compact && styles.connectionLabelCompact, { color: connectionColor }]} numberOfLines={1}>
              {visibleConnectionLabel}
            </Text>
            <Text style={[styles.connectionChevron, compact && styles.connectionChevronCompact]}>+</Text>
          </Pressable>
        </View>

        <View style={[styles.metaRow, compact && styles.metaRowCompact]}>
          <Text style={[styles.metaLabel, compact && styles.metaLabelCompact]} numberOfLines={1}>SESSION  /  PRESENT-01</Text>
          <Text style={[styles.metaClock, compact && styles.metaClockCompact]}>{clock}</Text>
        </View>

        <View style={[styles.deckCard, compact && styles.deckCardCompact]}>
          <View style={[styles.deckCardGlow, compact && styles.deckCardGlowCompact]} />
          <View style={styles.deckCardTopline}>
            <View style={styles.liveLabel}>
              <View style={[styles.liveDot, compact && styles.liveDotCompact]} />
              <Text style={[styles.overline, compact && styles.overlineCompact]}>LIVE DECK</Text>
            </View>
            <Text style={[styles.slideCount, compact && styles.slideCountCompact]}>
              {String(currentSlide).padStart(2, '0')} <Text style={styles.slideCountMuted}>/ {String(totalSlides).padStart(2, '0')}</Text>
            </Text>
          </View>

          <Text style={[styles.slideIndex, compact && styles.slideIndexCompact]}>{String(currentSlide).padStart(2, '0')}</Text>
          <Text style={[styles.slideTitle, compact && styles.slideTitleCompact]} numberOfLines={2}>
            {slideTitle}
          </Text>
          <View style={[styles.progressTrack, compact && styles.progressTrackCompact]}>
            <View style={[styles.progressFill, { width: progress }]} />
          </View>
          <View style={[styles.slideInfoRow, compact && styles.slideInfoRowCompact]}>
            <Text style={[styles.slideSection, compact && styles.slideSectionCompact]} numberOfLines={1}>{slideSection.toUpperCase()}</Text>
            <Text style={[styles.slidePercent, compact && styles.slidePercentCompact]}>{progress}</Text>
          </View>
        </View>

        <View style={[styles.controlsRow, compact && styles.controlsRowCompact]}>
          <Pressable
            accessibilityLabel="Diapositiva anterior"
            onPress={() => sendCommand('previous')}
            style={({ pressed }) => [styles.circleControl, compact && styles.circleControlCompact, pressed && styles.pressed]}
          >
            <Text style={[styles.arrowText, compact && styles.arrowTextCompact]}>‹</Text>
            <Text style={[styles.controlCaption, compact && styles.controlCaptionCompact]}>BACK</Text>
          </Pressable>

          <View style={[styles.playControlWrap, compact && styles.playControlWrapCompact]}>
            <View style={[styles.playHalo, compact && styles.playHaloCompact]} />
            <Pressable
              accessibilityLabel={state.isPlaying ? 'Pausar presentacion' : 'Reanudar presentacion'}
              onPress={() => sendCommand('toggle')}
              style={({ pressed }) => [styles.playControl, compact && styles.playControlCompact, pressed && styles.playPressed]}
            >
              <Text style={[styles.playIcon, compact && styles.playIconCompact]}>{state.isPlaying ? 'Ⅱ' : '▶'}</Text>
            </Pressable>
          </View>

          <Pressable
            accessibilityLabel="Siguiente diapositiva"
            onPress={() => sendCommand('next')}
            style={({ pressed }) => [styles.circleControl, compact && styles.circleControlCompact, pressed && styles.pressed]}
          >
            <Text style={[styles.arrowText, compact && styles.arrowTextCompact]}>›</Text>
            <Text style={[styles.controlCaption, compact && styles.controlCaptionCompact]}>NEXT</Text>
          </Pressable>
        </View>

        <View style={[styles.actionRow, compact && styles.actionRowCompact]}>
          <Pressable
            accessibilityLabel="Activar puntero laser"
            onPress={() => sendCommand('laser')}
            style={({ pressed }) => [styles.actionButton, compact && styles.actionButtonCompact, state.laserVisible && styles.actionButtonActive, pressed && styles.pressed]}
          >
            <View style={[styles.actionIcon, state.laserVisible && styles.actionIconActive]} />
            <Text style={[styles.actionButtonText, compact && styles.actionButtonTextCompact, state.laserVisible && styles.actionButtonTextActive]}>LASER</Text>
          </Pressable>
          <Pressable
            accessibilityLabel="Reiniciar presentacion"
            onPress={() => sendCommand('reset')}
            style={({ pressed }) => [styles.actionButton, compact && styles.actionButtonCompact, pressed && styles.pressed]}
          >
            <Text style={[styles.resetIcon, compact && styles.resetIconCompact]}>↺</Text>
            <Text style={[styles.actionButtonText, compact && styles.actionButtonTextCompact]}>RESET</Text>
          </Pressable>
        </View>

        <View style={[styles.bottomRow, compact && styles.bottomRowCompact]}>
          <View style={styles.crownHint}>
            <View style={styles.crownIcon}>
              <View style={styles.crownLine} />
              <View style={styles.crownLine} />
              <View style={styles.crownLine} />
            </View>
            <View>
              <Text style={styles.crownTitle}>CORONA / RUEDA</Text>
              <Text style={styles.crownDescription}>Gira para navegar</Text>
            </View>
          </View>
          <Text style={styles.actionText} numberOfLines={1}>{action}</Text>
        </View>
      </View>

      <Modal
        animationType="fade"
        transparent
        visible={showConnection}
        onRequestClose={() => setShowConnection(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <ScrollView contentContainerStyle={styles.modalContent} showsVerticalScrollIndicator={false}>
              <View style={styles.modalHeader}>
                <View>
                  <Text style={styles.overline}>CONNECTION HUB</Text>
                  <Text style={styles.modalTitle}>Elige tu puente</Text>
                </View>
                <Pressable onPress={() => setShowConnection(false)} style={styles.closeButton}>
                  <Text style={styles.closeText}>×</Text>
                </Pressable>
              </View>

              <Pressable
                onPress={selectWifi}
                style={({ pressed }) => [styles.transportCard, activeTransport === 'wifi' && styles.transportCardActive, pressed && styles.pressed]}
              >
                <View style={[styles.transportIcon, styles.transportIconWifi]}><Text style={styles.transportIconText}>W</Text></View>
                <View style={styles.transportCopy}>
                  <Text style={styles.transportTitle}>Wi-Fi / WebSocket</Text>
                  <Text style={styles.transportDescription}>Ideal para Android Studio Emulator</Text>
                </View>
                <View style={[styles.transportStatusDot, wifiStatus === 'connected' && styles.transportStatusOnline]} />
              </Pressable>

              <Pressable
                onPress={bleConnected ? () => setShowConnection(false) : scanBluetooth}
                style={({ pressed }) => [styles.transportCard, activeTransport === 'bluetooth' && styles.transportCardActive, pressed && styles.pressed]}
              >
                <View style={[styles.transportIcon, styles.transportIconBluetooth]}><Text style={styles.transportIconText}>B</Text></View>
                <View style={styles.transportCopy}>
                  <Text style={styles.transportTitle}>Bluetooth / BLE</Text>
                  <Text style={styles.transportDescription}>{bleConnected ? 'WristLink Bridge conectado' : 'Buscar bridge GATT cercano'}</Text>
                </View>
                {bleStatus === 'scanning' ? <ActivityIndicator color={colors.secondary} size="small" /> : <View style={[styles.transportStatusDot, bleConnected && styles.transportStatusOnline]} />}
              </Pressable>

              {bleDevices.length > 0 && (
                <View style={styles.deviceList}>
                  <Text style={styles.deviceListLabel}>DISPOSITIVOS ENCONTRADOS</Text>
                  {bleDevices.map((peripheral) => (
                    <Pressable
                      key={peripheral.id}
                      onPress={() => connectBluetooth(peripheral)}
                      style={({ pressed }) => [styles.deviceRow, pressed && styles.pressed]}
                    >
                      <View>
                        <Text style={styles.deviceName}>{getPeripheralName(peripheral)}</Text>
                        <Text style={styles.deviceId}>{peripheral.id}</Text>
                      </View>
                      <Text style={styles.deviceConnect}>LINK</Text>
                    </Pressable>
                  ))}
                </View>
              )}

              {bleConnected && (
                <Pressable onPress={disconnectBluetooth} style={styles.disconnectButton}>
                  <Text style={styles.disconnectText}>Desconectar Bluetooth</Text>
                </Pressable>
              )}

              <View style={styles.modalNote}>
                <Text style={styles.modalNoteTitle}>PARA EL EMULADOR</Text>
                <Text style={styles.modalNoteText}>Usa Wi-Fi con ws://10.0.2.2:3000. Bluetooth necesita un periférico GATT WristLink Bridge en la computadora.</Text>
              </View>
              <Text style={styles.bleMessage}>{bleMessage}</Text>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background
  },
  screenGlow: {
    position: 'absolute',
    top: -110,
    right: -70,
    width: 230,
    height: 230,
    borderRadius: 115,
    backgroundColor: 'rgba(113, 230, 244, 0.06)'
  },
  container: {
    flex: 1,
    paddingHorizontal: 18,
    paddingVertical: 12
  },
  containerCompact: {
    paddingHorizontal: 8,
    paddingVertical: 4
  },
  topbar: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between'
  },
  topbarCompact: {
    gap: 4
  },
  brandBlock: {
    alignItems: 'center',
    flexDirection: 'row'
  },
  brandBlockCompact: {
    flexShrink: 1
  },
  brandMarkCompact: {
    borderRadius: 6,
    height: 20,
    marginRight: 5,
    width: 20
  },
  brandMark: {
    alignItems: 'center',
    borderColor: colors.primary,
    borderRadius: 8,
    borderWidth: 1,
    height: 27,
    justifyContent: 'center',
    marginRight: 8,
    width: 27
  },
  brandMarkText: {
    color: colors.primary,
    fontSize: 14,
    fontWeight: '800'
  },
  brandMarkTextCompact: {
    fontSize: 11
  },
  brand: {
    color: colors.text,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.1
  },
  brandCompact: {
    fontSize: 8,
    letterSpacing: 0.55
  },
  brandSub: {
    color: colors.mutedDark,
    fontSize: 7,
    letterSpacing: 0.65,
    marginTop: 2
  },
  brandSubCompact: {
    fontSize: 5,
    letterSpacing: 0.25
  },
  connectionPill: {
    alignItems: 'center',
    backgroundColor: colors.backgroundRaised,
    borderColor: colors.line,
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: 'row',
    minHeight: 28,
    paddingHorizontal: 8
  },
  connectionPillCompact: {
    flexShrink: 0,
    maxWidth: 70,
    minHeight: 21,
    paddingHorizontal: 4
  },
  connectionDot: {
    borderRadius: 4,
    height: 6,
    marginRight: 5,
    width: 6
  },
  connectionLabel: {
    fontSize: 7,
    fontWeight: '800',
    letterSpacing: 0.4
  },
  connectionLabelCompact: {
    fontSize: 5,
    letterSpacing: 0
  },
  connectionChevron: {
    color: colors.muted,
    fontSize: 15,
    lineHeight: 13,
    marginLeft: 5,
    transform: [{ rotate: '45deg' }]
  },
  connectionChevronCompact: {
    fontSize: 10,
    marginLeft: 2
  },
  metaRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 13
  },
  metaRowCompact: {
    marginTop: 3
  },
  metaLabel: {
    color: colors.mutedDark,
    fontSize: 7,
    fontWeight: '700',
    letterSpacing: 0.65
  },
  metaLabelCompact: {
    fontSize: 5,
    letterSpacing: 0.2
  },
  metaClock: {
    color: colors.muted,
    fontSize: 9,
    fontWeight: '600',
    letterSpacing: 0.6
  },
  metaClockCompact: {
    fontSize: 7
  },
  deckCard: {
    backgroundColor: colors.card,
    borderColor: colors.line,
    borderRadius: 21,
    borderWidth: 1,
    justifyContent: 'space-between',
    marginTop: 10,
    minHeight: 166,
    overflow: 'hidden',
    padding: 17
  },
  deckCardCompact: {
    borderRadius: 12,
    marginTop: 4,
    minHeight: 64,
    padding: 6
  },
  deckCardGlow: {
    backgroundColor: 'rgba(184, 243, 107, 0.08)',
    borderRadius: 80,
    height: 160,
    position: 'absolute',
    right: -75,
    top: -82,
    width: 160
  },
  deckCardGlowCompact: {
    borderRadius: 45,
    height: 90,
    right: -42,
    top: -46,
    width: 90
  },
  deckCardTopline: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between'
  },
  liveLabel: {
    alignItems: 'center',
    flexDirection: 'row'
  },
  liveDot: {
    backgroundColor: colors.primary,
    borderRadius: 3,
    height: 6,
    marginRight: 6,
    width: 6
  },
  liveDotCompact: {
    borderRadius: 2,
    height: 4,
    marginRight: 4,
    width: 4
  },
  overline: {
    color: colors.primary,
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 1
  },
  overlineCompact: {
    fontSize: 6,
    letterSpacing: 0.6
  },
  slideCount: {
    color: colors.text,
    fontSize: 9,
    fontWeight: '700'
  },
  slideCountCompact: {
    fontSize: 6
  },
  slideCountMuted: {
    color: colors.mutedDark,
    fontWeight: '500'
  },
  slideIndex: {
    color: colors.mutedDark,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    marginTop: 13
  },
  slideIndexCompact: {
    fontSize: 6,
    marginTop: 3
  },
  slideTitle: {
    color: colors.text,
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: -1.3,
    lineHeight: 27,
    marginTop: 2
  },
  slideTitleCompact: {
    fontSize: 12,
    lineHeight: 12,
    marginTop: 0
  },
  progressTrack: {
    backgroundColor: colors.line,
    borderRadius: 2,
    height: 3,
    marginTop: 12,
    overflow: 'hidden'
  },
  progressTrackCompact: {
    height: 2,
    marginTop: 3
  },
  progressFill: {
    backgroundColor: colors.primary,
    borderRadius: 2,
    height: '100%'
  },
  slideInfoRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 6
  },
  slideInfoRowCompact: {
    marginTop: 2
  },
  slideSection: {
    color: colors.muted,
    fontSize: 7,
    fontWeight: '700',
    letterSpacing: 0.7
  },
  slideSectionCompact: {
    fontSize: 5,
    letterSpacing: 0.2
  },
  slidePercent: {
    color: colors.primary,
    fontSize: 8,
    fontWeight: '700'
  },
  slidePercentCompact: {
    fontSize: 6
  },
  controlsRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 14,
    paddingHorizontal: 12
  },
  controlsRowCompact: {
    marginTop: 3,
    paddingHorizontal: 0
  },
  circleControl: {
    alignItems: 'center',
    backgroundColor: colors.backgroundRaised,
    borderColor: colors.line,
    borderRadius: 29,
    borderWidth: 1,
    height: 58,
    justifyContent: 'center',
    width: 58
  },
  circleControlCompact: {
    borderRadius: 18,
    height: 36,
    width: 36
  },
  arrowText: {
    color: colors.text,
    fontSize: 30,
    fontWeight: '300',
    lineHeight: 26
  },
  arrowTextCompact: {
    fontSize: 20,
    lineHeight: 18
  },
  controlCaption: {
    color: colors.muted,
    fontSize: 6,
    fontWeight: '800',
    letterSpacing: 0.6,
    marginTop: -1
  },
  controlCaptionCompact: {
    fontSize: 5,
    letterSpacing: 0.3
  },
  playControlWrap: {
    alignItems: 'center',
    height: 72,
    justifyContent: 'center',
    width: 72
  },
  playControlWrapCompact: {
    height: 40,
    width: 40
  },
  playHalo: {
    backgroundColor: 'rgba(184, 243, 107, 0.12)',
    borderRadius: 34,
    height: 68,
    position: 'absolute',
    width: 68
  },
  playHaloCompact: {
    borderRadius: 21,
    height: 42,
    width: 42
  },
  playControl: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: 27,
    height: 54,
    justifyContent: 'center',
    width: 54
  },
  playControlCompact: {
    borderRadius: 18,
    height: 36,
    width: 36
  },
  playIcon: {
    color: colors.ink,
    fontSize: 18,
    fontWeight: '900'
  },
  playIconCompact: {
    fontSize: 12
  },
  actionRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12
  },
  actionRowCompact: {
    marginBottom: 4,
    marginTop: 4
  },
  actionButton: {
    alignItems: 'center',
    backgroundColor: colors.backgroundRaised,
    borderColor: colors.line,
    borderRadius: 10,
    borderWidth: 1,
    flex: 1,
    flexDirection: 'row',
    height: 32,
    justifyContent: 'center'
  },
  actionButtonCompact: {
    height: 16
  },
  actionButtonActive: {
    backgroundColor: 'rgba(255, 140, 140, 0.12)',
    borderColor: colors.danger
  },
  actionIcon: {
    backgroundColor: colors.danger,
    borderRadius: 4,
    height: 7,
    marginRight: 6,
    width: 7
  },
  actionIconActive: {
    shadowColor: colors.danger,
    shadowOpacity: 0.9,
    shadowRadius: 5
  },
  actionButtonText: {
    color: colors.muted,
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 0.7
  },
  actionButtonTextCompact: {
    fontSize: 5,
    letterSpacing: 0.25
  },
  actionButtonTextActive: {
    color: colors.danger
  },
  resetIcon: {
    color: colors.muted,
    fontSize: 15,
    marginRight: 5
  },
  resetIconCompact: {
    fontSize: 10,
    marginRight: 3
  },
  bottomRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 'auto',
    paddingTop: 10
  },
  bottomRowCompact: {
    display: 'none'
  },
  crownHint: {
    alignItems: 'center',
    flexDirection: 'row'
  },
  crownIcon: {
    alignItems: 'center',
    borderColor: colors.secondary,
    borderRadius: 7,
    borderWidth: 1,
    flexDirection: 'row',
    height: 25,
    justifyContent: 'center',
    marginRight: 7,
    width: 25
  },
  crownLine: {
    backgroundColor: colors.secondary,
    borderRadius: 2,
    height: 11,
    marginHorizontal: 1,
    width: 2
  },
  crownTitle: {
    color: colors.secondary,
    fontSize: 7,
    fontWeight: '800',
    letterSpacing: 0.6
  },
  crownDescription: {
    color: colors.mutedDark,
    fontSize: 7,
    marginTop: 2
  },
  actionText: {
    color: colors.muted,
    flex: 1,
    fontSize: 7,
    marginLeft: 10,
    textAlign: 'right'
  },
  pressed: {
    opacity: 0.65,
    transform: [{ scale: 0.97 }]
  },
  playPressed: {
    opacity: 0.75,
    transform: [{ scale: 0.94 }]
  },
  modalBackdrop: {
    backgroundColor: 'rgba(3, 9, 13, 0.94)',
    flex: 1,
    justifyContent: 'center',
    padding: 13
  },
  modalCard: {
    backgroundColor: colors.backgroundRaised,
    borderColor: colors.line,
    borderRadius: 20,
    borderWidth: 1,
    maxHeight: '92%'
  },
  modalContent: {
    padding: 16
  },
  modalHeader: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 14
  },
  modalTitle: {
    color: colors.text,
    fontSize: 21,
    fontWeight: '700',
    letterSpacing: -0.7,
    marginTop: 5
  },
  closeButton: {
    alignItems: 'center',
    backgroundColor: colors.card,
    borderRadius: 15,
    height: 30,
    justifyContent: 'center',
    width: 30
  },
  closeText: {
    color: colors.muted,
    fontSize: 22,
    lineHeight: 24
  },
  transportCard: {
    alignItems: 'center',
    backgroundColor: colors.card,
    borderColor: colors.line,
    borderRadius: 13,
    borderWidth: 1,
    flexDirection: 'row',
    marginBottom: 9,
    minHeight: 66,
    paddingHorizontal: 11,
    paddingVertical: 9
  },
  transportCardActive: {
    borderColor: colors.primary,
    backgroundColor: colors.cardSoft
  },
  transportIcon: {
    alignItems: 'center',
    borderRadius: 10,
    height: 34,
    justifyContent: 'center',
    marginRight: 10,
    width: 34
  },
  transportIconWifi: {
    backgroundColor: 'rgba(184, 243, 107, 0.14)'
  },
  transportIconBluetooth: {
    backgroundColor: 'rgba(113, 230, 244, 0.14)'
  },
  transportIconText: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '900'
  },
  transportCopy: {
    flex: 1
  },
  transportTitle: {
    color: colors.text,
    fontSize: 11,
    fontWeight: '700'
  },
  transportDescription: {
    color: colors.muted,
    fontSize: 8,
    lineHeight: 12,
    marginTop: 3
  },
  transportStatusDot: {
    backgroundColor: colors.mutedDark,
    borderRadius: 4,
    height: 7,
    width: 7
  },
  transportStatusOnline: {
    backgroundColor: colors.primary
  },
  deviceList: {
    borderTopColor: colors.line,
    borderTopWidth: 1,
    marginTop: 3,
    paddingTop: 11
  },
  deviceListLabel: {
    color: colors.mutedDark,
    fontSize: 7,
    fontWeight: '800',
    letterSpacing: 0.8,
    marginBottom: 6
  },
  deviceRow: {
    alignItems: 'center',
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 9
  },
  deviceName: {
    color: colors.text,
    fontSize: 10,
    fontWeight: '700'
  },
  deviceId: {
    color: colors.mutedDark,
    fontSize: 7,
    marginTop: 3
  },
  deviceConnect: {
    color: colors.secondary,
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 0.7
  },
  disconnectButton: {
    alignItems: 'center',
    borderColor: colors.danger,
    borderRadius: 9,
    borderWidth: 1,
    height: 32,
    justifyContent: 'center',
    marginTop: 10
  },
  disconnectText: {
    color: colors.danger,
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 0.5
  },
  modalNote: {
    backgroundColor: 'rgba(113, 230, 244, 0.07)',
    borderLeftColor: colors.secondary,
    borderLeftWidth: 2,
    marginTop: 14,
    padding: 10
  },
  modalNoteTitle: {
    color: colors.secondary,
    fontSize: 7,
    fontWeight: '800',
    letterSpacing: 0.8
  },
  modalNoteText: {
    color: colors.muted,
    fontSize: 8,
    lineHeight: 13,
    marginTop: 4
  },
  bleMessage: {
    color: colors.mutedDark,
    fontSize: 8,
    lineHeight: 12,
    marginTop: 10,
    textAlign: 'center'
  }
});
