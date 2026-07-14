const UI = {
    screen1: document.getElementById('screen1'),
    screen2: document.getElementById('screen2'),
    connectForm: document.getElementById('connectForm'),
    connectBtn: document.getElementById('connectBtn'),
    wsUrlInput: document.getElementById('wsUrl'),
    usernameInput: document.getElementById('username'),
    targetUsernameInput: document.getElementById('targetUsername'),
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
let username = '';
let targetUsername = '';
let keyExchangeInterval = null;
const MAX_BYTES = 245;

// Prevent form submission from reloading page
UI.connectForm.addEventListener('submit', (e) => {
    e.preventDefault();
    initConnection();
});

function initConnection() {
    UI.connectBtn.disabled = true;
    UI.connectBtn.textContent = 'Generating RSA Keys...';
    
    // Allow UI to update before synchronous key generation
    setTimeout(() => {
        try {
            keyPair = new JSEncrypt({default_key_size: 2048});
            keyPair.getKey(); // synchronous block ~1-2s
            UI.connectBtn.disabled = false;
            UI.connectBtn.textContent = 'Connect';
            connect();
        } catch(e) {
            alert("Failed to generate keys. Please try another browser.");
            UI.connectBtn.disabled = false;
            UI.connectBtn.textContent = 'Connect';
        }
    }, 50);
}

function connect() {
    const url = UI.wsUrlInput.value.trim();
    username = UI.usernameInput.value.trim();
    targetUsername = UI.targetUsernameInput.value.trim();
    
    if (!url || !username || !targetUsername) return;
    
    try {
        ws = new WebSocket(url);
    } catch(e) {
        alert("Invalid WebSocket URL");
        return;
    }
    
    UI.chatTargetName.textContent = targetUsername;
    UI.screen1.classList.add('hidden');
    UI.screen2.classList.remove('hidden');
    UI.messagesDiv.innerHTML = '';
    partnerPublicKey = null;
    UI.chatInput.disabled = true;
    UI.sendBtn.disabled = true;
    UI.chatInput.value = '';
    updateCharCounter();
    
    updateStatus('Connecting...', 'yellow');
    
    ws.onopen = () => {
        updateStatus('Registering...', 'yellow');
        ws.send(JSON.stringify({ type: 'register', username: username }));
    };
    
    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handleServerMessage(data);
        } catch(e) {
            console.error("Failed to parse message", e);
        }
    };
    
    ws.onclose = () => {
        updateStatus('Disconnected', 'red');
        stopKeyExchange();
        addSystemMessage("Connection lost.");
        UI.chatInput.disabled = true;
        UI.sendBtn.disabled = true;
    };
    
    ws.onerror = (error) => {
        console.error("WS error", error);
    };
}

UI.disconnectBtn.addEventListener('click', () => {
    if (ws) {
        ws.close();
    }
    stopKeyExchange();
    UI.screen2.classList.add('hidden');
    UI.screen1.classList.remove('hidden');
});

function handleServerMessage(data) {
    if (data.type === 'ok') {
        addSystemMessage("Registered successfully.");
        startKeyExchange();
    } else if (data.type === 'error') {
        addSystemMessage("Error: " + data.message, 'error');
    } else if (data.type === 'from') {
        if (data.sender !== targetUsername) return; // Ignore messages from others
        
        let decodedPayload;
        try {
            decodedPayload = atob(data.payload);
        } catch(e) {
            console.error("Base64 decode failed", e);
            return;
        }
        
        // Forward compatibility: check if it's a public key
        if (decodedPayload.includes("-----BEGIN PUBLIC KEY-----") || 
            decodedPayload.includes("-----BEGIN RSA PUBLIC KEY-----")) {
            partnerPublicKey = decodedPayload;
            stopKeyExchange();
            updateStatus('Connected (🔒 E2E Encrypted)', 'green');
            addSystemMessage("Partner's public key received. Secure channel established.");
            UI.chatInput.disabled = false;
            UI.sendBtn.disabled = false;
            UI.chatInput.focus();
        } else {
            if (!partnerPublicKey) {
                console.warn("Received encrypted message before partner public key.");
                return;
            }
            
            // Decrypt chat message
            // JSEncrypt.decrypt expects base64 ciphertext
            const decrypted = keyPair.decrypt(data.payload); 
            if (decrypted === false) {
                addSystemMessage("Decrypt failure: unable to read message.", 'error');
            } else {
                addChatMessage(targetUsername, decrypted, 'partner');
            }
        }
    }
}

function sendPublicKey() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        const pubKey = keyPair.getPublicKey();
        const base64PubKey = btoa(pubKey);
        ws.send(JSON.stringify({
            type: 'msg',
            target: targetUsername,
            payload: base64PubKey
        }));
    }
}

function startKeyExchange() {
    updateStatus('Waiting for partner key...', 'yellow');
    sendPublicKey();
    keyExchangeInterval = setInterval(() => {
        sendPublicKey();
    }, 3000);
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

function addChatMessage(sender, text, type) {
    const wrapper = document.createElement('div');
    wrapper.className = `message-wrapper ${type}`;
    
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    bubble.textContent = text;
    
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    
    const time = new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    
    if (type === 'self') {
        meta.innerHTML = `🔒 ${time}`;
    } else {
        meta.innerHTML = `${sender} • ${time} 🔒`;
    }
    
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
    
    // JSEncrypt.encrypt returns base64 encoded string
    const ciphertextBase64 = encryptor.encrypt(text);
    
    if (ciphertextBase64 === false) {
        alert("Encryption failed. Message might be too long.");
        return;
    }
    
    ws.send(JSON.stringify({
        type: 'msg',
        target: targetUsername,
        payload: ciphertextBase64
    }));
    
    addChatMessage(username, text, 'self');
    UI.chatInput.value = '';
    updateCharCounter();
});

function updateCharCounter() {
    const text = UI.chatInput.value;
    const bytes = new Blob([text]).size; 
    UI.charCounter.textContent = `${bytes} / ${MAX_BYTES}`;
    if (bytes > MAX_BYTES) {
        UI.charCounter.classList.add('error');
    } else {
        UI.charCounter.classList.remove('error');
    }
}

UI.chatInput.addEventListener('input', updateCharCounter);
