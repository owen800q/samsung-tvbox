import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { initPlatform } from './platform/tizen';

initPlatform();
createRoot(document.getElementById('root')).render(<App />);
