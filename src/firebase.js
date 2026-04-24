// src/firebase.js
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "본인의_API_KEY",
  authDomain: "본인의_프로젝트.firebaseapp.com",
  projectId: "본인의_프로젝트_ID",
  storageBucket: "본인의_프로젝트.appspot.com",
  messagingSenderId: "본인의_발송자ID",
  appId: "본인의_APP_ID"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app); // 외부에서 DB에 접근할 수 있도록 내보냅니다.