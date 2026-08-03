/**
 * Ccfolia SW2.5 Dice Cut-in Helper Content Script
 */

// Configuration constants
const CONFIG = {
  COMMAND_DELAY: 500,                  // Delay between sending queued messages (ms)
  REACT_TRIGGER_DELAY: 100,            // Delay before triggering Enter/click (ms)
  TAB_FOCUS_IGNORE_DURATION: 1500,     // Ignore messages duration after tab visibility changes (ms)
  OBSERVER_RECONNECT_INTERVAL: 3000,   // Interval to check for detached/changed chat container (ms)
  MAX_SIGNATURE_QUEUE_SIZE: 1000,      // Max size of processed signatures queue
  MAX_TEXT_CONTENT_LENGTH: 3000,       // Max text length for message signature container
  MAX_DOM_SEARCH_DEPTH: 8,             // Search depth to find the chat container
  MAX_SIGNATURE_SEARCH_DEPTH: 4,       // Search depth to find signature node
  MAX_TEXTAREA_SEARCH_DEPTH: 5,        // Search depth for button/textarea proximity search
  BULK_RENDER_THRESHOLD: 5,            // Threshold of nodes to trigger silent sync (skip sending commands)
  CHAT_TEXTAREA_KEYWORDS: ['送信', 'チャット', 'Enter', 'メッセージ']
};

// Global state
const state = {
  chatObserver: null,
  observedContainer: null,
  commandQueue: [],
  isProcessingQueue: false,
  isTabJustFocused: false,
  tabFocusTimeout: null,
  lastVisibleTime: Date.now(),
  processedSignatureCounts: new Map(),
  processedSignaturesQueue: [],
  processedNodes: new WeakSet()
};

/**
 * Extract leaf elements (minimum message units) containing SW2.5 dice markers.
 * Filters out elements that have children also containing the markers.
 */
function extractLeafMessages(rootNode) {
  if (!rootNode) return [];
  const allElements = [rootNode, ...Array.from(rootNode.querySelectorAll('*'))];
  const leafMessages = [];

  for (const el of allElements) {
    const text = el.textContent || "";
    if (text.includes('＞') || text.includes('>')) {
      let childHasMarker = false;
      for (const child of el.children) {
        const childText = child.textContent || "";
        if (childText.includes('＞') || childText.includes('>')) {
          childHasMarker = true;
          break;
        }
      }
      if (!childHasMarker) {
        leafMessages.push(el);
      }
    }
  }
  return leafMessages;
}

/**
 * Queue a chat command to prevent message collisions
 */
function queueChatMessage(command) {
  state.commandQueue.push(command);
  processCommandQueue();
}

function processCommandQueue() {
  if (state.isProcessingQueue || state.commandQueue.length === 0) return;
  state.isProcessingQueue = true;
  
  const command = state.commandQueue.shift();
  sendChatMessage(command);
  
  setTimeout(() => {
    state.isProcessingQueue = false;
    processCommandQueue();
  }, CONFIG.COMMAND_DELAY);
}

/**
 * Split multi-rolls (e.g. #1 ..., #2 ...)
 */
function splitMultiRolls(text) {
  if (/#1\s+/.test(text)) {
    return text.split(/#\d+\s*/).filter(p => p.trim().length > 0);
  }
  return [text];
}

/**
 * Mark a signature as processed, managing the queue size
 */
function markProcessed(signature) {
  if (!signature) return;
  const sig = signature.trim();
  if (!sig) return;
  
  const currentCount = state.processedSignatureCounts.get(sig) || 0;
  state.processedSignatureCounts.set(sig, currentCount + 1);
  
  state.processedSignaturesQueue.push(sig);
  if (state.processedSignaturesQueue.length > CONFIG.MAX_SIGNATURE_QUEUE_SIZE) {
    const oldest = state.processedSignaturesQueue.shift();
    const count = state.processedSignatureCounts.get(oldest) || 0;
    if (count <= 1) {
      state.processedSignatureCounts.delete(oldest);
    } else {
      state.processedSignatureCounts.set(oldest, count - 1);
    }
  }
}

// Track tab visibility changes
document.addEventListener('visibilitychange', () => {
  clearTimeout(state.tabFocusTimeout);
  if (document.hidden) {
    state.isTabJustFocused = true;
  } else {
    state.isTabJustFocused = true;
    state.lastVisibleTime = Date.now();
    // Ignore messages for a brief period after tab becomes visible
    state.tabFocusTimeout = setTimeout(() => {
      state.isTabJustFocused = false;
    }, CONFIG.TAB_FOCUS_IGNORE_DURATION);
  }
});

/**
 * Locate the chat textarea among multiple textareas
 */
function getChatTextarea() {
  const textareas = document.querySelectorAll('textarea');
  if (textareas.length === 0) return null;
  if (textareas.length === 1) return textareas[0];

  // 1. Check placeholder keywords (prevent matching character sheets)
  for (const ta of textareas) {
    const ph = ta.placeholder || "";
    if (CONFIG.CHAT_TEXTAREA_KEYWORDS.some(kw => ph.includes(kw))) {
      return ta;
    }
  }

  // 2. Proximity search: find textarea near a button
  for (const ta of textareas) {
    let parent = ta.parentElement;
    for (let i = 0; i < CONFIG.MAX_TEXTAREA_SEARCH_DEPTH && parent; i++) {
      const buttons = parent.querySelectorAll('button');
      if (buttons.length > 0) {
        return ta;
      }
      parent = parent.parentElement;
    }
  }
  
  // 3. Fallback to the last textarea
  return textareas[textareas.length - 1];
}

/**
 * Find the chat container dynamically by climbing up from textarea
 */
function findChatContainer() {
  const textarea = getChatTextarea();
  if (!textarea) return null;

  let container = textarea;
  for (let i = 0; i < CONFIG.MAX_DOM_SEARCH_DEPTH && container.parentElement; i++) {
    container = container.parentElement;
  }
  return container;
}

/**
 * Parse SW2.5 dice bot results to identify fumble/critical conditions
 */
function parseDiceResult(text) {
  const isDiceRoll = text.includes('＞') || text.includes('>');
  if (!isDiceRoll) return [];

  const actions = [];

  // 1. Critical rolls (e.g. "3回転")
  const rotationMatches = [...text.matchAll(/(\d+)\s*回転/g)];
  for (const match of rotationMatches) {
    actions.push({ type: 'critical', rotations: parseInt(match[1], 10) });
  }

  // 2. Fumble rolls on power tables ("自動的失敗")
  if (/自動的失敗/.test(text)) {
    actions.push({ type: 'fumble', rotations: 0 });
  }

  // 3. Skill checks (2D6)
  const isSkillCheck = text.includes('(2D6') && !text.includes('[D]');

  // Fumble (1,1) or "自動失敗"
  if (isSkillCheck && (text.includes('[1,1]') || text.includes('自動失敗'))) {
    actions.push({ type: 'skill_fumble', rotations: 0 });
  }

  // Critical (6,6) or "自動成功"
  if (isSkillCheck && (text.includes('[6,6]') || text.includes('自動成功'))) {
    actions.push({ type: 'skill_critical', rotations: 0 });
  }

  return actions;
}

/**
 * Determine the exact chat command corresponding to a parsed action
 */
function determineCommand(action) {
  switch (action.type) {
    case 'fumble':
      return '@ファンブル';
    case 'skill_fumble':
      return '@自動失敗';
    case 'critical':
      return '@クリティカル';
    case 'skill_critical':
      return '@自動成功';
    default:
      return null;
  }
}

/**
 * Insert and send a command in the Ccfolia React chat interface
 */
function sendChatMessage(command) {
  const textarea = getChatTextarea();
  if (!textarea) {
    console.error('[Ccfolia SW2.5 Helper] Textarea not found!');
    return;
  }

  textarea.focus();

  // Bypass React state binding via native value setter
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value"
  ).set;
  nativeInputValueSetter.call(textarea, command);

  // Notify React of the input state change
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.dispatchEvent(new Event('change', { bubbles: true }));

  setTimeout(() => {
    // 1. Dispatch full sequence of keyboard events for Enter key
    const eventParams = {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true
    };
    textarea.dispatchEvent(new KeyboardEvent('keydown', eventParams));
    textarea.dispatchEvent(new KeyboardEvent('keypress', eventParams));
    textarea.dispatchEvent(new KeyboardEvent('keyup', eventParams));

    // 2. Proximity search fallback: find and click the send button
    let sendButton = null;
    let parent = textarea.parentElement;
    for (let i = 0; i < CONFIG.MAX_TEXTAREA_SEARCH_DEPTH && parent; i++) {
      const buttons = parent.querySelectorAll('button');
      if (buttons.length > 0) {
        sendButton = buttons[buttons.length - 1];
        break;
      }
      parent = parent.parentElement;
    }

    if (sendButton) {
      sendButton.click();
    }
  }, CONFIG.REACT_TRIGGER_DELAY);
}

/**
 * Traverse DOM up to locate signature container (containing character name/time)
 */
function getMessageSignatureNode(leafNode) {
  let signatureNode = leafNode;
  for (let i = 0; i < CONFIG.MAX_SIGNATURE_SEARCH_DEPTH; i++) {
    if (signatureNode.parentElement && signatureNode.parentElement.textContent.length < CONFIG.MAX_TEXT_CONTENT_LENGTH) {
      signatureNode = signatureNode.parentElement;
    } else {
      break;
    }
  }
  return signatureNode;
}

/**
 * Retrieve unique signature string of a message node
 */
function getMessageSignature(leafNode) {
  return getMessageSignatureNode(leafNode).textContent.trim();
}

/**
 * Map current occurrences of all chat signatures on DOM
 */
function countDOMSignatures(container) {
  const domSignatureCounts = new Map();
  if (!container) return domSignatureCounts;

  const leafMessages = extractLeafMessages(container);
  const countedNodes = new Set();

  for (const leaf of leafMessages) {
    const sigNode = getMessageSignatureNode(leaf);
    if (!countedNodes.has(sigNode)) {
      countedNodes.add(sigNode);
      const sig = sigNode.textContent.trim();
      domSignatureCounts.set(sig, (domSignatureCounts.get(sig) || 0) + 1);
    }
  }
  return domSignatureCounts;
}

/**
 * Clean up state signatures that no longer exist on DOM (garbage collection)
 */
function gcProcessedSignatures(domSignatureCounts) {
  for (const [sig, processedCount] of state.processedSignatureCounts.entries()) {
    const domCount = domSignatureCounts.get(sig) || 0;
    if (domCount < processedCount) {
      if (domCount === 0) {
        state.processedSignatureCounts.delete(sig);
      } else {
        state.processedSignatureCounts.set(sig, domCount);
      }
    }
  }
}

/**
 * Silent sync of new nodes (typically for initial renders or bulk loading)
 */
function syncNodesSilently(nodes) {
  for (const node of nodes) {
    const leafMessages = extractLeafMessages(node);
    for (const leaf of leafMessages) {
      state.processedNodes.add(leaf);
      const signature = getMessageSignature(leaf);
      markProcessed(signature);
    }
  }
}

/**
 * Process a single message node, parse dice results, and queue commands if appropriate
 */
function processIndividualMessages(rootNode, domSignatureCounts) {
  // Grace period to recover isTabJustFocused flag
  if (state.isTabJustFocused && !document.hidden && Date.now() - state.lastVisibleTime > 2000) {
    state.isTabJustFocused = false;
  }
  
  if (document.hidden || state.isTabJustFocused) return;

  const leafMessages = extractLeafMessages(rootNode);
  const uniqueSignatures = new Set();

  for (const leaf of leafMessages) {
    if (state.processedNodes.has(leaf)) continue;
    state.processedNodes.add(leaf);

    const signature = getMessageSignature(leaf);
    if (uniqueSignatures.has(signature)) continue;
    uniqueSignatures.add(signature);

    const currentDOMCount = domSignatureCounts.get(signature) || 0;
    const processedCount = state.processedSignatureCounts.get(signature) || 0;

    if (currentDOMCount <= processedCount) continue;

    // Avoid self-trigger loops: skip messages containing auto-injected commands
    if (signature.includes('@クリティカル') || signature.includes('@ファンブル') || signature.includes('@自動成功') || signature.includes('@自動失敗')) {
      markProcessed(signature);
      continue;
    }

    const rolls = splitMultiRolls(signature);
    let matchedAny = false;

    for (const rollText of rolls) {
      const actions = parseDiceResult(rollText);
      for (const action of actions) {
        const command = determineCommand(action);
        if (!command) continue;

        console.log(`[Ccfolia SW2.5 Helper] Detected event:`, action, `-> Queueing: ${command}`);
        queueChatMessage(command);
        matchedAny = true;
      }
    }

    if (matchedAny) {
      markProcessed(signature);
    }
  }
}

/**
 * Initialize and start the MutationObserver on the chat container.
 */
function startChatObserver() {
  const container = findChatContainer();
  if (!container) {
    setTimeout(startChatObserver, 1000);
    return;
  }

  state.observedContainer = container;
  console.log('[Ccfolia SW2.5 Helper] Observer initialized. Monitoring chat updates...');

  // Reset tracking lists on start
  state.processedSignatureCounts.clear();
  state.processedSignaturesQueue.length = 0;

  // Mark all existing messages as processed initially
  const leafMessages = extractLeafMessages(container);
  for (const leaf of leafMessages) {
    state.processedNodes.add(leaf);
    const signature = getMessageSignature(leaf);
    markProcessed(signature);
  }

  let pendingNodes = [];
  let processingTimeout = null;

  state.chatObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            pendingNodes.push(node);
          }
        }
      }
    }

    // Debounce processing to handle rapid consecutive node additions
    clearTimeout(processingTimeout);
    processingTimeout = setTimeout(() => {
      if (pendingNodes.length === 0) return;

      const currentContainer = findChatContainer();
      const domSignatureCounts = countDOMSignatures(currentContainer);

      // Clean up old signatures no longer present on DOM
      gcProcessedSignatures(domSignatureCounts);

      // Handle massive updates silently (e.g. room load or channel switch)
      if (pendingNodes.length > CONFIG.BULK_RENDER_THRESHOLD) {
        console.log(`[Ccfolia SW2.5 Helper] Bulk render detected (${pendingNodes.length} nodes). Syncing count silently.`);
        syncNodesSilently(pendingNodes);
        pendingNodes = [];
        return;
      }

      // Process newly added nodes
      for (const node of pendingNodes) {
        processIndividualMessages(node, domSignatureCounts);
      }
      pendingNodes = [];
    }, 50);
  });

  state.chatObserver.observe(container, {
    childList: true,
    subtree: true
  });
}

// Initial entry point
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startChatObserver);
} else {
  startChatObserver();
}

// Re-initialization recovery for SPAs
setInterval(() => {
  const currentContainer = findChatContainer();
  if (state.chatObserver && (!document.body.contains(state.observedContainer) || currentContainer !== state.observedContainer)) {
    console.log('[Ccfolia SW2.5 Helper] Chat container detached or changed. Re-initializing...');
    state.chatObserver.disconnect();
    state.chatObserver = null;
    state.observedContainer = null;
    startChatObserver();
  }
}, CONFIG.OBSERVER_RECONNECT_INTERVAL);
