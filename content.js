/**
 * Ccfolia SW2.5 Dice Cut-in Helper Content Script
 */

// State variables
let chatObserver = null;
let observedContainer = null;
let isSendingCommand = false;

// Tab visibility state (to prevent queued messages firing when switching back to tab)
let isTabJustFocused = false;
let tabFocusTimeout = null;

// Track previously processed message texts to prevent firing on DOM remounts
const processedMessages = new Set();
const processedMessagesQueue = [];

function markProcessed(text) {
  if (!text) return;
  const t = text.trim();
  if (!t) return;
  if (!processedMessages.has(t)) {
    processedMessages.add(t);
    processedMessagesQueue.push(t);
    if (processedMessagesQueue.length > 200) {
      const oldest = processedMessagesQueue.shift();
      processedMessages.delete(oldest);
    }
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    isTabJustFocused = true;
    clearTimeout(tabFocusTimeout);
  } else {
    isTabJustFocused = true;
    clearTimeout(tabFocusTimeout);
    // Ignore messages for 1.5 seconds after tab becomes visible
    tabFocusTimeout = setTimeout(() => {
      isTabJustFocused = false;
    }, 1500);
  }
});

/**
 * 1. Find the chat container element dynamically.
 * パフォーマンス向上のため、body全体ではなく、チャット入力欄(textarea)の周辺コンテナを監視対象とします。
 */
function findChatContainer() {
  const textarea = document.querySelector('textarea');
  if (!textarea) {
    return null;
  }

  // テキストエリアの祖先要素を遡り、チャットログと入力欄を包含する領域を推定する
  // ココフォリアの難読化クラス名に依存せず、DOMの階層をたどることで構造変更に強くしています
  let container = textarea;
  for (let i = 0; i < 8 && container.parentElement; i++) {
    container = container.parentElement;
  }
  return container;
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

// メッセージの最小単位（リーフノード）から、一意のシグネチャ（名前・時刻・内容を含むテキスト）を生成する
function getMessageSignature(leafNode) {
  let signatureNode = leafNode;
  let signature = signatureNode.textContent || "";
  // 構造を数階層遡り、名前や時刻を含む親コンテナを探す
  for (let i = 0; i < 3; i++) {
    if (signatureNode.parentElement && signatureNode.parentElement.textContent.length < 500) {
      signatureNode = signatureNode.parentElement;
      signature = signatureNode.textContent || "";
    } else {
      break; // コンテナが巨大すぎる（親要素が全体リストなど）場合はストップ
    }
  }
  return signature.trim();
}

/**
 * 追加されたノードの中から個々のメッセージ要素を抽出し、処理する
 */
function processIndividualMessages(rootNode) {
  if (isSendingCommand) return;
  if (document.hidden || isTabJustFocused) return;

  const allElements = [rootNode, ...Array.from(rootNode.querySelectorAll('*'))];
  const leafMessages = [];

  // ダイス結果を含む最小単位の要素（リーフノード）を探す
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

  // 見つかった個々のメッセージに対して処理を実行
  for (const leaf of leafMessages) {
    const diceText = leaf.textContent || "";
    const signature = getMessageSignature(leaf);

    if (processedMessages.has(signature)) {
      continue; // 既に処理済みの完全一致メッセージ（リマウント等）は無視
    }

    if (diceText.includes('@クリティカル') || diceText.includes('@ファンブル') || diceText.includes('@自動成功') || diceText.includes('@自動失敗')) {
      markProcessed(signature);
      continue;
    }

    const action = parseDiceResult(diceText);
    if (!action) continue;

    const command = determineCommand(action);
    if (!command) continue;

    console.log(`[Ccfolia SW2.5 Helper] Detected event:`, action, `-> Sending: ${command}`);

    markProcessed(signature);

    // Prevent double triggers with short cooldown
    isSendingCommand = true;
    sendChatMessage(command);
    
    setTimeout(() => {
      isSendingCommand = false;
    }, 1500);
  }
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

  // 初期化時に、現在DOMに存在する既存のメッセージを個別に解析し「処理済み」として登録する
  // 複数メッセージの結合文字列ではなく、後で抽出されるのと同じ「シグネチャ」で登録することが重要
  const allElements = container.querySelectorAll('*');
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

  for (const leaf of leafMessages) {
    const signature = getMessageSignature(leaf);
    markProcessed(signature);
  }

  let pendingNodes = [];
  let processingTimeout = null;

  chatObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            pendingNodes.push(node);
          }
        }
      }
    }

    // デバウンス処理: 複数の一括追加を検知するため、わずかに待つ
    clearTimeout(processingTimeout);
    processingTimeout = setTimeout(() => {
      // 1回の描画サイクルで大量のノードが追加された場合は、再描画(リマウント)や初期読み込みとみなして無視する
      if (pendingNodes.length > 5) {
        console.log(`[Ccfolia SW2.5 Helper] Ignored ${pendingNodes.length} nodes due to bulk render.`);
      } else {
        for (const node of pendingNodes) {
          processIndividualMessages(node);
        }
      }
      pendingNodes = [];
    }, 50);
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
