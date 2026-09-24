/**
 * Ccfolia SW2.5 Dice Cut-in Helper Content Script
 *
 * 検知の方針:
 *   ココフォリアのチャット欄は仮想リスト（表示範囲の行だけDOMに存在）で、
 *   チャットタブ切り替えやスクロールのたびに同じメッセージの行が作り直される。
 *   そのためDOMの追加やテキストでは「新着」を判定できない。
 *   各行のReactコンポーネントが持つメッセージオブジェクト（_id / createdAt / extend.roll）を読み、
 *     - _id で一度処理したメッセージは二度と処理しない
 *     - createdAt が「これまでに見た最新時刻」より新しく、かつ直近 FRESH_WINDOW 以内のものだけを新着とみなす
 *   ことで、再描画による再発火と読み込み時の誤発火を防ぐ。
 *   React内部を読むため、manifest で world: "MAIN" として実行する。
 */

// Configuration constants
const CONFIG = {
  COMMAND_DELAY: 500,                  // Delay between sending queued messages (ms)
  REACT_TRIGGER_DELAY: 100,            // Delay before triggering Enter/click (ms)
  SCAN_THROTTLE: 100,                  // Min interval between DOM scans (ms)
  FRESH_WINDOW: 30000,                 // Only messages created within this window are fired (ms). Prevents late cut-ins
                                       // for messages first rendered later (other chat tab, background browser tab)
  MAX_SEEN_IDS: 5000,                  // Max number of message ids to remember
  MAX_FIBER_CLIMB: 10,                 // Fiber levels to climb from a row to the message component
  MAX_TEXTAREA_SEARCH_DEPTH: 5,        // Search depth for button/textarea proximity search
  CHAT_ROW_SELECTOR: 'ul[role="log"] [data-index]',
  CHAT_TEXTAREA_KEYWORDS: ['送信', 'チャット', 'Enter', 'メッセージ']
};

const LOG_PREFIX = '[Ccfolia SW2.5 Helper]';

// Global state
const state = {
  commandQueue: [],
  isProcessingQueue: false,
  seenIds: new Set(),        // Message ids already handled (insertion ordered)
  highWater: null,           // Newest createdAt (ms) observed so far; null until the first scan
  warnedNoMessage: false
};

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
  try {
    sendChatMessage(command);
  } catch (e) {
    console.error(`${LOG_PREFIX} Exception caught in sendChatMessage:`, e);
  } finally {
    // Ensure the queue is never locked up by using finally block
    setTimeout(() => {
      state.isProcessingQueue = false;
      processCommandQueue();
    }, CONFIG.COMMAND_DELAY);
  }
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
 * Locate the chat textarea among multiple textareas
 */
function getChatTextarea() {
  try {
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
  } catch (e) {
    console.error(`${LOG_PREFIX} Error getting chat textarea:`, e);
    return null;
  }
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
    console.error(`${LOG_PREFIX} Textarea not found!`);
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
    try {
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
    } catch (e) {
      console.error(`${LOG_PREFIX} Error triggering Enter/Click:`, e);
    }
  }, CONFIG.REACT_TRIGGER_DELAY);
}

/**
 * Get the React fiber attached to a DOM element
 */
function getFiber(el) {
  for (const key in el) {
    if (key.startsWith('__reactFiber$')) return el[key];
  }
  return null;
}

/**
 * Find the Ccfolia message object ({ _id, createdAt, extend, ... }) rendered in a chat row.
 * Climbs from the row's fiber to the component that receives `messageId`,
 * then looks through its hook states for the object whose _id matches.
 */
function getMessageFromRow(row) {
  const inner = row.firstElementChild || row;
  let fiber = getFiber(inner);
  for (let i = 0; i < CONFIG.MAX_FIBER_CLIMB && fiber; i++) {
    const props = fiber.memoizedProps;
    if (props && typeof props.messageId === 'string') {
      return findMessageInHooks(fiber, props.messageId);
    }
    fiber = fiber.return;
  }
  return null;
}

function findMessageInHooks(fiber, messageId) {
  const isTarget = (v) => v && typeof v === 'object' && v._id === messageId;
  let hook = fiber.memoizedState;
  for (let i = 0; i < 100 && hook; i++) {
    const v = hook.memoizedState;
    if (isTarget(v)) return v;
    if (v && typeof v === 'object') {
      if (isTarget(v.current)) return v.current;
      if (v.current && isTarget(v.current.value)) return v.current.value;
    }
    hook = hook.next;
  }
  return null;
}

/**
 * createdAt (Firestore Timestamp / number / null) to milliseconds.
 * Returns null while the server timestamp is still pending (own message just sent).
 */
function toMillis(ts) {
  if (!ts) return null;
  if (typeof ts === 'number') return ts;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (typeof ts.seconds === 'number') return ts.seconds * 1000 + Math.floor((ts.nanoseconds || 0) / 1e6);
  return null;
}

function rememberId(id) {
  state.seenIds.add(id);
  if (state.seenIds.size > CONFIG.MAX_SEEN_IDS) {
    // Set keeps insertion order: drop the oldest
    state.seenIds.delete(state.seenIds.values().next().value);
  }
}

/**
 * Handle a newly arrived dice message
 */
function handleNewMessage(message) {
  const roll = message.extend && message.extend.roll;
  // Secret dice: firing a cut-in would reveal the result
  if (!roll || roll.secret || typeof roll.result !== 'string') return;

  for (const rollText of splitMultiRolls(roll.result)) {
    for (const action of parseDiceResult(rollText)) {
      const command = determineCommand(action);
      if (command) queueChatMessage(command);
    }
  }
}

/**
 * Scan all rendered chat rows and fire only for messages that are genuinely new.
 */
function scanChatRows() {
  const rows = document.querySelectorAll(CONFIG.CHAT_ROW_SELECTOR);
  if (rows.length === 0) return;

  const isFirstScan = state.highWater === null;
  const baseline = state.highWater ?? -Infinity;
  const oldestAllowed = Date.now() - CONFIG.FRESH_WINDOW;
  let newest = baseline;
  let foundAny = false;
  const fresh = [];

  for (const row of rows) {
    const message = getMessageFromRow(row);
    if (!message) continue;
    foundAny = true;

    if (state.seenIds.has(message._id)) continue;
    rememberId(message._id);

    const createdAt = toMillis(message.createdAt);
    if (createdAt !== null && createdAt > newest) newest = createdAt;

    if (isFirstScan) continue; // Existing log on load: mark only

    if (createdAt === null) {
      // Server timestamp still pending = posted from this client just now
      fresh.push({ message, order: Infinity });
    } else if (createdAt > baseline && createdAt > oldestAllowed) {
      fresh.push({ message, order: createdAt });
    }
  }

  if (!foundAny) {
    if (!state.warnedNoMessage) {
      state.warnedNoMessage = true;
      console.warn(`${LOG_PREFIX} Chat rows found but message data could not be read. Ccfolia's structure may have changed.`);
    }
    return;
  }

  state.highWater = newest;

  fresh.sort((a, b) => a.order - b.order);
  for (const { message } of fresh) {
    try {
      handleNewMessage(message);
    } catch (e) {
      console.error(`${LOG_PREFIX} Error handling message:`, e);
    }
  }
}

/**
 * Observe the whole document: the chat log element itself is replaced on
 * channel switches / layout changes, so a fixed container cannot be tracked reliably.
 */
function startObserver() {
  let timer = null;
  // Throttle (not debounce): continuous mutations elsewhere must not postpone the scan
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      try {
        scanChatRows();
      } catch (e) {
        console.error(`${LOG_PREFIX} Error in scan:`, e);
      }
    }, CONFIG.SCAN_THROTTLE);
  };

  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  schedule();
  console.log(`${LOG_PREFIX} Observer initialized. Monitoring chat updates...`);
}

// Initial entry point
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startObserver);
} else {
  startObserver();
}
