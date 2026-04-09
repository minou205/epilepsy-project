import React, { useState, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Dimensions,
  Platform,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';

interface QRScannerScreenProps {
  onScanned : (url: string) => void;
  onCancel  : () => void;
}

const { width: W, height: H } = Dimensions.get('window');
const RETICLE = 240;

const QRScannerScreen: React.FC<QRScannerScreenProps> = ({ onScanned, onCancel }) => {

  const [permission, requestPermission] = useCameraPermissions();
  const scannedRef = useRef(false);

  if (!permission) {
    return (
      <View style={styles.center}>
        <Text style={styles.infoText}>Requesting camera permission…</Text>
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={styles.center}>
        <Text style={styles.infoText}>Camera access is required to scan QR codes.</Text>
        <TouchableOpacity style={styles.btn} onPress={requestPermission}>
          <Text style={styles.btnText}>Grant Permission</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.btn, styles.btnSecondary]} onPress={onCancel}>
          <Text style={styles.btnText}>Enter IP Manually</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const handleBarcode = ({ data }: { data: string }) => {
    if (scannedRef.current) return;
    if (!data.startsWith('ws://')) return;
    scannedRef.current = true;
    onScanned(data);
  };

  return (
    <View style={styles.root}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={handleBarcode}
      />

      <View style={styles.overlay} pointerEvents="none">
        <View style={[styles.band, { height: (H - RETICLE) / 2 }]} />

        <View style={styles.middleRow}>
          <View style={[styles.band, { flex: 1 }]} />
          <View style={styles.reticle}>
            <View style={[styles.corner, styles.cornerTL]} />
            <View style={[styles.corner, styles.cornerTR]} />
            <View style={[styles.corner, styles.cornerBL]} />
            <View style={[styles.corner, styles.cornerBR]} />
          </View>
          <View style={[styles.band, { flex: 1 }]} />
        </View>

        <View style={[styles.band, { flex: 1 }]} />
      </View>

      <View style={styles.instrBox} pointerEvents="none">
        <Text style={styles.instrText}>Point at the QR code on the PC screen</Text>
        <Text style={styles.instrSub}>Looking for ws:// WebSocket address</Text>
      </View>

      <TouchableOpacity style={styles.cancelBtn} onPress={onCancel}>
        <Text style={styles.cancelText}>✕  Enter IP manually</Text>
      </TouchableOpacity>
    </View>
  );
};

const CORNER_SIZE = 22;
const CORNER_W    = 3;
const CORNER_CLR  = '#00FF88';

const styles = StyleSheet.create({
  root: {
    flex           : 1,
    backgroundColor: '#000',
  },
  center: {
    flex           : 1,
    backgroundColor: '#090915',
    justifyContent : 'center',
    alignItems     : 'center',
    padding        : 32,
    gap            : 16,
  },
  infoText: {
    color     : '#AAB8CC',
    fontSize  : 15,
    textAlign : 'center',
    lineHeight: 22,
  },
  btn: {
    backgroundColor  : '#00FF88',
    paddingVertical  : 12,
    paddingHorizontal: 28,
    borderRadius     : 10,
  },
  btnSecondary: {
    backgroundColor: '#1A2A3A',
  },
  btnText: {
    color     : '#090915',
    fontWeight: '700',
    fontSize  : 14,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: 'column',
  },
  band: {
    backgroundColor: 'rgba(0,0,0,0.62)',
  },
  middleRow: {
    height       : RETICLE,
    flexDirection: 'row',
  },
  reticle: {
    width : RETICLE,
    height: RETICLE,
  },
  corner: {
    position: 'absolute',
    width   : CORNER_SIZE,
    height  : CORNER_SIZE,
  },
  cornerTL: {
    top: 0, left: 0,
    borderTopWidth     : CORNER_W,
    borderLeftWidth    : CORNER_W,
    borderColor        : CORNER_CLR,
    borderTopLeftRadius: 4,
  },
  cornerTR: {
    top: 0, right: 0,
    borderTopWidth      : CORNER_W,
    borderRightWidth    : CORNER_W,
    borderColor         : CORNER_CLR,
    borderTopRightRadius: 4,
  },
  cornerBL: {
    bottom: 0, left: 0,
    borderBottomWidth      : CORNER_W,
    borderLeftWidth        : CORNER_W,
    borderColor            : CORNER_CLR,
    borderBottomLeftRadius : 4,
  },
  cornerBR: {
    bottom: 0, right: 0,
    borderBottomWidth      : CORNER_W,
    borderRightWidth       : CORNER_W,
    borderColor            : CORNER_CLR,
    borderBottomRightRadius: 4,
  },
  instrBox: {
    position  : 'absolute',
    top       : (H - RETICLE) / 2 + RETICLE + 24,
    left      : 0,
    right     : 0,
    alignItems: 'center',
  },
  instrText: {
    color     : '#E8F0FF',
    fontSize  : 15,
    fontWeight: '600',
    textAlign : 'center',
  },
  instrSub: {
    color    : '#556677',
    fontSize : 12,
    marginTop: 4,
    textAlign: 'center',
  },
  cancelBtn: {
    position         : 'absolute',
    bottom           : Platform.OS === 'android' ? 72 : 48,
    alignSelf        : 'center',
    paddingVertical  : 12,
    paddingHorizontal: 24,
    backgroundColor  : 'rgba(255,255,255,0.08)',
    borderRadius     : 24,
    borderWidth      : 1,
    borderColor      : '#334466',
  },
  cancelText: {
    color     : '#AAB8CC',
    fontSize  : 14,
    fontWeight: '600',
  },
});

export default QRScannerScreen;
