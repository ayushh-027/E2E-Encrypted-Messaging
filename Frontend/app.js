const UI = {
    screen1: document.getElementById('screen1'),
    screen2: document.getElementById('screen2'),
    wsUrlInput: document.getElementById('wsUrl'),
    modeSelect: document.getElementById('modeSelect'),
    createRoomBtn: document.getElementById('createRoomBtn'),
    joinRoomBtn: document.getElementById('joinRoomBtn'),
    joinForm: document.getElementById('joinForm'),
    roomCodeInput: document.getElementById('roomCodeInput'),
    joinBackBtn: document.getElementById('joinBackBtn'),
    waitingPanel: document.getElementById('waitingPanel'),
    roomCodeDisplay: document.getElementById('roomCodeDisplay'),
    copyCodeBtn: document.getElementById('copyCodeBtn'),
    waitingStatus: document.getElementById('waitingStatus'),
    loadingSpinner: document.getElementById('loadingSpinner'), // Added spinner reference
    cancelRoomBtn: document.getElementById('cancelRoomBtn'),
    messagesDiv: document.getElementById('messages'),
    chatForm: document.getElementById('chatForm'),
    chatInput: document.getElementById('chatInput'),
    charCounter: document.getElementById('charCounter'),
    statusIndicator: document.getElementById('statusIndicator'),
    chatTargetName: document.getElementById('chatTargetName'),
    disconnectBtn: document.getElementById('disconnectBtn'),
    sendBtn: document.getElementById('sendBtn')
};

let ws = null;
let keyPair = null;
let partnerPublicKey = null;
let roomCode = '';
let keyExchangeInterval = null;
const MAX_BYTES = 245;

UI.createRoomBtn.addEventListener('click', () => startFlow('create'));

UI.joinRoomBtn.addEventListener('click', () => {
    UI.modeSelect.classList.add('hidden');
    UI.joinForm.classList.remove('hidden');
    UI.roomCodeInput.value = '';
    UI.roomCodeInput.focus();
});

UI.joinBackBtn.addEventListener('click', showLobbyDefault);

UI.joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = UI.roomCodeInput.value.trim().toUpperCase();
    if (!code) return;
    startFlow('join', code);
});

UI.roomCodeInput.addEventListener('input', () => {
    UI.roomCodeInput.value = UI.roomCodeInput.value.toUpperCase();
});

UI.copyCodeBtn.addEventListener('click', () => {
    if (!roomCode) return;
    navigator.clipboard.writeText(roomCode).then(() => {
        const original = UI.copyCodeBtn.textContent;
        UI.copyCodeBtn.textContent = 'Copied!';
        setTimeout(() => { UI.copyCodeBtn.textContent = original; }, 1500);
    }).catch(() => {
        alert(`Room code: ${roomCode}`);
    });
});

UI.cancelRoomBtn.addEventListener('click', () => {
    if (ws) ws.close();
    resetToLobby();
});

function showLobbyDefault() {
    UI.modeSelect.classList.remove('hidden');
    UI.joinForm.classList.add('hidden');
    UI.waitingPanel.classList.add('hidden');
}

function startFlow(mode, code) {
    const url = UI.wsUrlInput.value.trim();
    if (!url) {
        alert('Please enter a WebSocket URL');
        return;
    }

    UI.modeSelect.classList.add('hidden');
    UI.joinForm.classList.add('hidden');
    UI.waitingPanel.classList.remove('hidden');
    UI.loadingSpinner.classList.remove('hide-spinner'); // Ensure spinner is visible
    roomCode = mode === 'join' ? code : '';
    UI.roomCodeDisplay.textContent = mode === 'join' ? code : '•••••';
    UI.waitingStatus.textContent = mode === 'create' ? 'Creating room...' : 'Joining room...';
    UI.copyCodeBtn.classList.toggle('hidden', mode === 'join');

    keyPair = new JSEncrypt({ default_key_size: 2048 });
    setTimeout(() => {
        try {
            keyPair.getKey();
        } catch (e) {
            alert('Failed to generate keys. Please try another browser.');
            resetToLobby();
            return;
        }
        connectSocket(mode, code);
    }, 50);
}

function connectSocket(mode, code) {
    const url = UI.wsUrlInput.value.trim();
    try {
        ws = new WebSocket(url);
    } catch (e) {
        alert('Invalid WebSocket URL');
        resetToLobby();
        return;
    }

    const connectTimeout = setTimeout(() => {
        if (ws && ws.readyState === WebSocket.CONNECTING) {
            UI.waitingStatus.textContent = 'Still waiting on the server (20s+). It may be asleep, misconfigured, or unreachable.';
        }
    }, 20000);

    ws.onopen = () => {
        clearTimeout(connectTimeout);
        if (mode === 'create') {
            ws.send(JSON.stringify({ type: 'create_room' }));
        } else {
            ws.send(JSON.stringify({ type: 'join_room', code: code }));
        }
    };

    ws.onmessage = (event) => {
        try {
            handleServerMessage(JSON.parse(event.data));
        } catch (e) {
            console.error('Failed to parse message', e);
        }
    };

    ws.onclose = () => {
        clearTimeout(connectTimeout);
        stopKeyExchange();
        if (!UI.screen2.classList.contains('hidden')) {
            updateStatus('Disconnected', 'red');
            addSystemMessage('Connection lost.');
            UI.chatInput.disabled = true;
            UI.sendBtn.disabled = true;
        } else if (!UI.waitingPanel.classList.contains('hidden')) {
            UI.waitingStatus.textContent = 'Connection failed. Is the server running?';
            UI.loadingSpinner.classList.add('hide-spinner');
            UI.roomCodeDisplay.textContent = 'ERROR';
        }
    };

    ws.onerror = (error) => {
        console.error('WS error', error);
        if (!UI.waitingPanel.classList.contains('hidden')) {
            UI.waitingStatus.textContent = 'Connection error. Check URL and server.';
            UI.loadingSpinner.classList.add('hide-spinner');
            UI.roomCodeDisplay.textContent = 'ERROR';
        }
    };
}

function handleServerMessage(data) {
    switch (data.type) {
        case 'room_created':
            roomCode = data.code;
            UI.roomCodeDisplay.textContent = roomCode;
            UI.copyCodeBtn.classList.remove('hidden');
            UI.waitingStatus.textContent = 'Waiting for partner to join...';
            break;

        case 'room_joined':
            roomCode = data.code;
            enterChat();
            break;

        case 'partner_joined':
            enterChat();
            break;

        case 'partner_left':
            stopKeyExchange();
            updateStatus('Partner left', 'red');
            addSystemMessage('Your partner left the room.');
            UI.chatInput.disabled = true;
            UI.sendBtn.disabled = true;
            break;

        case 'error':
            if (!UI.screen2.classList.contains('hidden')) {
                addSystemMessage('Error: ' + data.message, 'error');
            } else {
                UI.waitingStatus.textContent = data.message;
                UI.loadingSpinner.classList.add('hide-spinner');
            }
            break;

        case 'from':
            handleIncomingPayload(data);
            break;
    }
}

function handleIncomingPayload(data) {
    let decodedPayload;
    try {
        decodedPayload = atob(data.payload);
    } catch (e) {
        console.error('Base64 decode failed', e);
        return;
    }

    if (decodedPayload.includes('-----BEGIN PUBLIC KEY-----') ||
        decodedPayload.includes('-----BEGIN RSA PUBLIC KEY-----')) {
        partnerPublicKey = decodedPayload;
        stopKeyExchange();
        updateStatus('Connected (🔒 E2E Encrypted)', 'green');
        addSystemMessage("Partner's public key received. Secure channel established.");
        UI.chatInput.disabled = false;
        UI.sendBtn.disabled = false;
        UI.chatInput.focus();
        return;
    }

    if (!partnerPublicKey) {
        console.warn('Received encrypted message before partner public key.');
        return;
    }

    const decrypted = keyPair.decrypt(data.payload);
    if (decrypted === false) {
        addSystemMessage('Decrypt failure: unable to read message.', 'error');
    } else {
        addChatMessage(decrypted, 'partner');
    }
}

function enterChat() {
    UI.screen1.classList.add('hidden');
    UI.screen2.classList.remove('hidden');
    UI.messagesDiv.innerHTML = '';
    UI.chatTargetName.textContent = `Room ${roomCode}`;
    partnerPublicKey = null;
    UI.chatInput.disabled = true;
    UI.sendBtn.disabled = true;
    UI.chatInput.value = '';
    updateCharCounter();
    addSystemMessage(`Connected to room ${roomCode}.`);
    startKeyExchange();
}

function sendPublicKey() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        const pubKey = keyPair.getPublicKey();
        ws.send(JSON.stringify({ type: 'msg', payload: btoa(pubKey) }));
    }
}

function startKeyExchange() {
    updateStatus('Waiting for partner key...', 'yellow');
    sendPublicKey();
    keyExchangeInterval = setInterval(sendPublicKey, 3000);
}

function stopKeyExchange() {
    if (keyExchangeInterval) {
        clearInterval(keyExchangeInterval);
        keyExchangeInterval = null;
    }
}

function updateStatus(text, color) {
    UI.statusIndicator.textContent = text;
    UI.statusIndicator.className = `status ${color}`;
}

function addSystemMessage(text, type = '') {
    const wrapper = document.createElement('div');
    wrapper.className = `message-wrapper system ${type}`;

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    bubble.textContent = text;

    wrapper.appendChild(bubble);
    UI.messagesDiv.appendChild(wrapper);
    scrollToBottom();
}

function addChatMessage(text, type) {
    const wrapper = document.createElement('div');
    wrapper.className = `message-wrapper ${type}`;

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    bubble.textContent = text;

    const meta = document.createElement('div');
    meta.className = 'message-meta';
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    meta.innerHTML = type === 'self' ? `🔒 ${time}` : `${time} 🔒`;

    wrapper.appendChild(bubble);
    wrapper.appendChild(meta);
    UI.messagesDiv.appendChild(wrapper);
    scrollToBottom();
}

function scrollToBottom() {
    UI.messagesDiv.scrollTop = UI.messagesDiv.scrollHeight;
}

UI.chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!partnerPublicKey) {
        alert("Waiting for partner's public key. Cannot send messages yet.");
        return;
    }

    const text = UI.chatInput.value;
    if (!text) return;

    const bytes = new Blob([text]).size;
    if (bytes > MAX_BYTES) {
        alert(`Message is too long (${bytes} bytes). Maximum is ${MAX_BYTES} bytes.`);
        return;
    }

    const encryptor = new JSEncrypt();
    encryptor.setPublicKey(partnerPublicKey);
    const ciphertextBase64 = encryptor.encrypt(text);

    if (ciphertextBase64 === false) {
        alert('Encryption failed. Message might be too long.');
        return;
    }

    ws.send(JSON.stringify({ type: 'msg', payload: ciphertextBase64 }));
    addChatMessage(text, 'self');
    UI.chatInput.value = '';
    updateCharCounter();
});

function updateCharCounter() {
    const text = UI.chatInput.value;
    const bytes = new Blob([text]).size;
    UI.charCounter.textContent = `${bytes} / ${MAX_BYTES}`;
    UI.charCounter.classList.toggle('error', bytes > MAX_BYTES);
}

UI.chatInput.addEventListener('input', updateCharCounter);

UI.disconnectBtn.addEventListener('click', () => {
    if (ws) ws.send(JSON.stringify({ type: 'leave_room' }));
    if (ws) ws.close();
    stopKeyExchange();
    resetToLobby();
});

function resetToLobby() {
    UI.screen2.classList.add('hidden');
    UI.screen1.classList.remove('hidden');
    showLobbyDefault();
    ws = null;
    partnerPublicKey = null;
    roomCode = '';
}
