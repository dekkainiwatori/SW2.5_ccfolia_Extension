/**
 * Ccfolia SW2.5 Dice Cut-in Helper Content Script
 */

// State variables
let chatObserver = null;
let observedContainer = null;
let isSendingCommand = false;

/**
 * 1. Find the chat container element dynamically.
 * Uses a heuristic approach (scrollable ancestor of the textarea) to support minified class names.
 */
function findChatContainer() {
  // ココフォリアなどのモダンSPAでは、DOM構造の入れ子が深く動的なため
  // body要素全体を監視対象とするのが最も確実です。
  return document.body;
}

/**
 * 2. Parse the text content of a new message node using regex.
 * Detects "自動的失敗" (fumble) or "[number]回転" (critical) for Sword World 2.5.
 */
function parseDiceResult(text) {
  // Check if it is likely a dice bot output (contains arrow separator '＞' or '>')
  const isDiceRoll = text.includes('＞') || text.includes('>');
  if (!isDiceRoll) return null;

  // Check for "自動的失敗" (Power Table Fumble)
  if (/自動的失敗/.test(text)) {
    return { type: 'fumble', rotations: 0 };
  }

  // Check for "[number]回転" (Power Table Critical)
  const rotationMatch = text.match(/(\d+)回転/);
  if (rotationMatch) {
    const rotations = parseInt(rotationMatch[1], 10);
    return { type: 'critical', rotations: rotations };
  }

  // 1. Skill Check: Exclude monster damage marked by [D]
  const isSkillCheck = text.includes('(2D6') && !text.includes('[D]');

  // 2. Detect Skill Check Fumble (1,1)
  if (isSkillCheck && text.includes('2[1,1]')) {
    return { type: 'skill_fumble', rotations: 0 };
  }

  // 3. Detect Skill Check Critical (6,6)
  if (isSkillCheck && text.includes('12[6,6]')) {
    return { type: 'skill_critical', rotations: 0 };
  }

  return null;
}

/**
 * 3. Map the parsed action to a chat command.
 * Designed for future extensibility (e.g., sending different commands based on rotation count).
 */
function determineCommand(action) {
  if (action.type === 'fumble') {
    return '@ファンブル';
  }
  
  if (action.type === 'skill_fumble') {
    return '@自動失敗';
  }
  
  if (action.type === 'critical') {
    // Future extensibility: Customize command based on action.rotations
    // e.g., if (action.rotations >= 3) return '@スーパークリティカル';
    return '@クリティカル';
  }
  
  if (action.type === 'skill_critical') {
    return '@自動成功';
  }
  
  return null;
}

/**
 * 4. Input and send a message via React-controlled textarea.
 */
function sendChatMessage(command) {
  const textarea = document.querySelector('textarea');
  if (!textarea) {
    console.error('[Ccfolia SW2.5 Helper] Textarea not found!');
    return;
  }

  // テキストエリアにフォーカスを当てる（Reactがアクティブ状態を要求する場合があるため）
  textarea.focus();

  // Bypass React 15/16+ state binding using native value setter
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value"
  ).set;
  nativeInputValueSetter.call(textarea, command);

  // Trigger event to notify React of the input change
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  // 念のため change イベントも発火
  textarea.dispatchEvent(new Event('change', { bubbles: true }));

  // Wait briefly for React to update its state, then trigger Enter and click
  setTimeout(() => {
    // 1. Enterキーのキーボードイベントを完全なシーケンスで発火 (keydown -> keypress -> keyup)
    // Reactはkeyupなどで送信をフックしている場合があるため、すべて発火させる
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

    // 2. フォールバック: 送信ボタンを探してクリック
    let sendButton = null;
    let parent = textarea.parentElement;
    for (let i = 0; i < 5 && parent; i++) { // 探索範囲を少し広げる
      const buttons = parent.querySelectorAll('button');
      if (buttons.length > 0) {
        // 複数ある場合は一番最後（通常は送信ボタン）を取得
        sendButton = buttons[buttons.length - 1];
        break;
      }
      parent = parent.parentElement;
    }

    if (sendButton) {
      sendButton.click();
    }
  }, 100);
}

/**
 * 5. Handle a newly added message node.
 * Filters out system commands and prevents infinite loop.
 */
function handleNewMessage(node) {
  if (isSendingCommand) return;

  const text = node.textContent || "";

  // Prevent infinite loop if the log records our own command
  if (text.includes('@クリティカル') || text.includes('@ファンブル') || text.includes('@自動成功') || text.includes('@自動失敗')) {
    return;
  }

  const action = parseDiceResult(text);
  if (!action) return;

  const command = determineCommand(action);
  if (!command) return;

  console.log(`[Ccfolia SW2.5 Helper] Detected event:`, action, `-> Sending: ${command}`);

  // Prevent double triggers with short cooldown/lock
  isSendingCommand = true;
  sendChatMessage(command);
  
  setTimeout(() => {
    isSendingCommand = false;
  }, 1500);
}

/**
 * Initialize and start the MutationObserver on the chat container.
 */
function startChatObserver() {
  const container = findChatContainer();
  if (!container) {
    // Retry finding the chat container
    setTimeout(startChatObserver, 1000);
    return;
  }

  observedContainer = container;
  console.log('[Ccfolia SW2.5 Helper] Observer initialized. Monitoring chat updates...');

  chatObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            handleNewMessage(node);
          }
        }
      }
    }
  });

  chatObserver.observe(container, {
    childList: true,
    subtree: true // DOMのどの深さにメッセージが追加されても確実に検知する
  });
}

// Start the observer on load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startChatObserver);
} else {
  startChatObserver();
}

// Dynamic recovery for Single Page Application (SPA) view updates / room changes
setInterval(() => {
  if (chatObserver && (!document.body.contains(observedContainer) || !findChatContainer())) {
    console.log('[Ccfolia SW2.5 Helper] Chat container detached or changed. Re-initializing...');
    chatObserver.disconnect();
    chatObserver = null;
    observedContainer = null;
    startChatObserver();
  }
}, 3000);
