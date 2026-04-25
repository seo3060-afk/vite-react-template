// src/firebase.js
import { initializeApp } from "firebase/app";
// getFirestore 대신 initializeFirestore를 불러옵니다.
import { initializeFirestore } from "firebase/firestore"; 

const firebaseConfig = {
  apiKey: "AIzaSyBXzvciioF4pDr8toK7WbGI2Y14AnDzdiA",
  authDomain: "aeo-system.firebaseapp.com",
  projectId: "aeo-system",
  storageBucket: "aeo-system.firebasestorage.app",
  messagingSenderId: "527118650104",
  appId: "1:527118650104:web:0e21fc83270922819b090d"
};

const app = initializeApp(firebaseConfig);

// ⭐️ 사내 방화벽 우회 설정: 웹소켓이 차단된 환경에서도 데이터를 주고받을 수 있게 강제 설정합니다.
export const db = initializeFirestore(app, {
  experimentalForceLongPolling: true
});