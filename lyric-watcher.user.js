// ==UserScript==
// @name         Immersive Lyric Engine - Lyric Watcher
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Watch NetEase Cloud Music lyric DOM and forward to local player
// @match        https://music.163.com/*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(function() {
    'use strict';

    const LYRIC_WS_URL = 'ws://localhost:8766';
    const STATUS_WS_URL = 'ws://localhost:8765';

    let lyricWs = null;
    let statusWs = null;
    let currentLyric = '';
    let reconnectDelay = 1000;
    let lastTextNode = null;

    function sendLyric(text) {
        if (!text || text === currentLyric) return;
        currentLyric = text;

        const msg = JSON.stringify({
            type: 'lyric',
            text: text,
            timestamp: new Date().toISOString()
        });

        if (lyricWs && lyricWs.readyState === WebSocket.OPEN) {
            lyricWs.send(msg);
        }
    }

    function sendStatus(message) {
        const msg = JSON.stringify({
            type: 'status',
            message: message,
            timestamp: new Date().toISOString()
        });

        if (statusWs && statusWs.readyState === WebSocket.OPEN) {
            statusWs.send(msg);
        }
    }

    function connectLyricWs() {
        try {
            lyricWs = new WebSocket(LYRIC_WS_URL);

            lyricWs.onopen = () => {
                console.log('[ILE Lyric] Connected to lyric service');
                reconnectDelay = 1000;
            };

            lyricWs.onclose = () => {
                console.log('[ILE Lyric] Disconnected from lyric service');
                setTimeout(connectLyricWs, reconnectDelay);
                reconnectDelay = Math.min(reconnectDelay * 2, 10000);
            };

            lyricWs.onerror = (err) => {
                console.warn('[ILE Lyric] WebSocket error:', err);
            };

        } catch (err) {
            console.error('[ILE Lyric] Failed to connect:', err);
            setTimeout(connectLyricWs, reconnectDelay);
        }
    }

    function connectStatusWs() {
        try {
            statusWs = new WebSocket(STATUS_WS_URL);

            statusWs.onopen = () => {
                console.log('[ILE Status] Connected to audio service');
                sendStatus('Tampermonkey lyric watcher ready');
            };

            statusWs.onclose = () => {
                setTimeout(connectStatusWs, 5000);
            };

        } catch (err) {
            console.warn('[ILE Status] Failed to connect:', err);
            setTimeout(connectStatusWs, 5000);
        }
    }

    const LYRIC_SELECTORS = [
        '.lyric-line',
        '.geci-lyric',
        '.j-lyric',
        '.lyric-panel .lyric',
        '[class*="lyric"]',
        '[class*="geci"]',
        '.xbubble',
        '.lyricContent',
        '.lrc-content',
        '.lrc-line',
        '#lyricContent',
        '#lyric-panel',
        '.js-lrc',
        '.n-lrc',
    ];

    function findLyricElement() {
        for (const sel of LYRIC_SELECTORS) {
            const el = document.querySelector(sel);
            if (el && el.textContent.trim()) {
                return el;
            }
        }

        const allText = document.querySelectorAll('span, div, p');
        for (const el of allText) {
            const text = el.textContent;
            if (text && text.match(/\[\d{2}:\d{2}/)) {
                return el;
            }
        }

        return null;
    }

    function extractLyricText(element) {
        if (!element) return '';

        let text = element.textContent || '';

        text = text.replace(/\[\d{2}:\d{2}[.\d]*\]/g, '');
        text = text.replace(/\[\d{2}:\d{2}[.\d]*\n?/g, '');
        text = text.trim();

        return text;
    }

    function watchLyricPanel() {
        const observer = new MutationObserver((mutations) => {
            const lyricEl = findLyricElement();
            if (lyricEl) {
                const text = extractLyricText(lyricEl);
                if (text && text !== currentLyric) {
                    sendLyric(text);
                    lastTextNode = lyricEl;
                }
            }
        });

        const tryObserve = () => {
            const lyricEl = findLyricElement();
            if (lyricEl) {
                console.log('[ILE Lyric] Found lyric element:', lyricEl.className);
                observer.observe(lyricEl.parentElement || lyricEl, {
                    childList: true,
                    subtree: true,
                    characterData: true
                });

                const initialText = extractLyricText(lyricEl);
                if (initialText) {
                    sendLyric(initialText);
                }

                return true;
            }
            return false;
        };

        if (!tryObserve()) {
            const checkInterval = setInterval(() => {
                if (tryObserve()) {
                    clearInterval(checkInterval);
                }
            }, 1000);

            setTimeout(() => clearInterval(checkInterval), 30000);
        }
    }

    function watchLyricTextNodes() {
        const textNodeObserver = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.type === 'characterData') {
                    const text = mutation.target.textContent;
                    if (text && text.trim() && !text.match(/^\d+$/)) {
                        const cleaned = extractLyricText({ textContent: text });
                        if (cleaned && cleaned !== currentLyric) {
                            sendLyric(cleaned);
                        }
                    }
                }
            }
        });

        const allElements = document.querySelectorAll('*');
        for (const el of allElements) {
            for (const child of el.childNodes) {
                if (child.nodeType === Node.TEXT_NODE) {
                    const text = child.textContent;
                    if (text && text.match(/\[\d{2}:\d{2}/)) {
                        textNodeObserver.observe(child.parentElement || el, {
                            characterData: true,
                            subtree: true
                        });
                    }
                }
            }
        }
    }

    function init() {
        console.log('[ILE Lyric] Starting lyric watcher...');

        setTimeout(() => {
            connectLyricWs();
            connectStatusWs();
            watchLyricPanel();
            watchLyricTextNodes();
        }, 2000);

        console.log('[ILE Lyric] Initialized');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();