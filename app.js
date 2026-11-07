(function () {
  'use strict';

  var STORAGE_KEY = 'todo.tasks.v1';

  // Статичная разметка галочки внутри чекбокса (без пользовательских данных).
  var CHECK_SVG =
    '<svg viewBox="0 0 14 11" aria-hidden="true" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path class="check-path" d="M1.5 6 L5 9.5 L12.5 1.5"/></svg>';

  var form = document.getElementById('task-form');
  var input = document.getElementById('task-input');
  var hintEl = document.getElementById('form-hint');
  var listEl = document.getElementById('task-list');
  var counterEl = document.getElementById('counter');
  var emptyEl = document.getElementById('empty-state');
  var warningEl = document.getElementById('storage-warning');
  var todayEl = document.getElementById('today');
  var undoNoteEl = document.getElementById('undo-note');
  var undoTextEl = document.getElementById('undo-text');
  var undoBtn = document.getElementById('undo-btn');

  var tasks = [];
  var storageAvailable = true;

  // Отмена последнего удаления: хранится только в памяти страницы.
  var UNDO_TIMEOUT_MS = 7000;
  var undoState = null; // { task, nextId } — nextId нужен, чтобы вернуть задачу на место, даже если список пополнился
  var undoTimer = null;

  /* ---------- Хранилище ---------- */

  function loadTasks() {
    var raw;
    try {
      raw = window.localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      storageAvailable = false;
      showWarning('Хранилище браузера недоступно. Задачи будут работать, но не сохранятся после закрытия страницы.');
      return [];
    }

    if (raw === null) {
      return [];
    }

    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      showWarning('Сохранённые данные повреждены, поэтому список начат заново.');
      return [];
    }

    if (!Array.isArray(parsed)) {
      showWarning('Сохранённые данные повреждены, поэтому список начат заново.');
      return [];
    }

    // Оставляем только корректные записи: {id: строка, text: строка, done: булево}.
    var cleaned = [];
    var seenIds = {};
    for (var i = 0; i < parsed.length; i++) {
      var item = parsed[i];
      if (!item || typeof item !== 'object') continue;
      if (typeof item.text !== 'string') continue;
      var text = item.text.trim();
      if (!text) continue;
      if (typeof item.id !== 'string' || !item.id || seenIds[item.id]) continue;
      seenIds[item.id] = true;
      cleaned.push({ id: item.id, text: text, done: item.done === true });
    }
    return cleaned;
  }

  function saveTasks() {
    if (!storageAvailable) {
      return false;
    }
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
      hideWarning();
      return true;
    } catch (e) {
      showWarning('Не удалось сохранить задачи. Изменения видны только до перезагрузки страницы.');
      return false;
    }
  }

  /* ---------- Сообщения ---------- */

  function showWarning(message) {
    warningEl.textContent = message;
    warningEl.hidden = false;
  }

  function hideWarning() {
    warningEl.hidden = true;
    warningEl.textContent = '';
  }

  function showHint(message) {
    hintEl.textContent = message;
    hintEl.hidden = false;
  }

  function hideHint() {
    hintEl.hidden = true;
    hintEl.textContent = '';
  }

  /* ---------- Задачи ---------- */

  function makeId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    // Запасной вариант с криптостойким генератором, если randomUUID недоступен.
    if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
      var buf = new Uint8Array(16);
      window.crypto.getRandomValues(buf);
      var hex = '';
      for (var i = 0; i < buf.length; i++) {
        hex += ('0' + buf[i].toString(16)).slice(-2);
      }
      return 'task-' + hex;
    }
    // Последний рубеж для очень старых браузеров: время + счётчик.
    makeId.counter = (makeId.counter || 0) + 1;
    return 'task-' + Date.now().toString(36) + '-' + makeId.counter;
  }

  function addTaskFromInput() {
    var text = input.value.trim();
    if (!text) {
      showHint('Введите текст задачи.');
      input.focus();
      return;
    }

    tasks.unshift({ id: makeId(), text: text, done: false });
    input.value = '';
    hideHint();
    saveTasks();
    listEl.insertBefore(createTaskItem(tasks[0]), listEl.firstChild);
    updateMeta();
    input.focus();
  }

  function createTaskItem(task) {
    var li = document.createElement('li');
    li.className = 'task-item' + (task.done ? ' task-item--done' : '');
    li.dataset.id = task.id;

    var label = document.createElement('label');
    label.className = 'task-label';

    // Настоящий чекбокс (прозрачный, для клавиатуры и кликов) + видимая коробка.
    var checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'task-check';
    checkbox.checked = task.done;

    var box = document.createElement('span');
    box.className = 'task-box';
    box.setAttribute('aria-hidden', 'true');
    box.innerHTML = CHECK_SVG; // статичная строка, пользовательских данных нет

    var textSpan = document.createElement('span');
    textSpan.className = 'task-text';
    textSpan.textContent = task.text; // только как текст, не как HTML

    label.appendChild(checkbox);
    label.appendChild(box);
    label.appendChild(textSpan);

    var deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'task-delete';
    deleteButton.textContent = 'Удалить';
    deleteButton.setAttribute('aria-label', 'Удалить задачу: ' + task.text);

    li.appendChild(label);
    li.appendChild(deleteButton);
    return li;
  }

  function findTaskIndex(id) {
    for (var i = 0; i < tasks.length; i++) {
      if (tasks[i].id === id) return i;
    }
    return -1;
  }

  function deleteTask(li) {
    var index = findTaskIndex(li.dataset.id);
    if (index === -1) return;

    // Удаление сохраняется сразу; запоминаем задачу и соседа справа для отмены.
    undoState = {
      task: tasks[index],
      nextId: index + 1 < tasks.length ? tasks[index + 1].id : null
    };
    tasks.splice(index, 1);
    saveTasks();
    showUndo();

    var nextLi = li.nextElementSibling || li.previousElementSibling;
    li.remove();
    if (nextLi && nextLi.querySelector('.task-check')) {
      nextLi.querySelector('.task-check').focus();
    } else {
      input.focus();
    }
    updateMeta();
  }

  /* ---------- Отмена последнего удаления ---------- */

  function showUndo() {
    undoTextEl.textContent = 'Задача удалена.';
    undoNoteEl.hidden = false;
    if (undoTimer) clearTimeout(undoTimer);
    undoTimer = setTimeout(hideUndo, UNDO_TIMEOUT_MS);
  }

  function hideUndo() {
    undoTimer = null;
    undoNoteEl.hidden = true;
    undoState = null;
    // Если фокус остался на исчезнувшей кнопке, возвращаем его в поле.
    if (document.activeElement === undoBtn) {
      input.focus();
    }
  }

  function undoDelete() {
    if (!undoState) return;
    var task = undoState.task;
    var nextId = undoState.nextId;
    undoState = null;
    hideUndo();

    // Возвращаем на прежнее место: перед бывшим соседом справа, иначе в конец.
    var insertIndex = tasks.length;
    for (var i = 0; i < tasks.length; i++) {
      if (tasks[i].id === nextId) {
        insertIndex = i;
        break;
      }
    }
    tasks.splice(insertIndex, 0, task);
    saveTasks();

    renderAll();

    var li = null;
    for (var j = 0; j < listEl.children.length; j++) {
      if (listEl.children[j].dataset.id === task.id) {
        li = listEl.children[j];
        break;
      }
    }
    if (li && li.querySelector('.task-check')) {
      li.querySelector('.task-check').focus();
    } else {
      input.focus();
    }
  }

  /* ---------- Счётчик и пустой экран ---------- */

  function pluralize(n, forms) {
    var mod10 = n % 10;
    var mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return forms[0];
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
    return forms[2];
  }

  function updateMeta() {
    var total = tasks.length;
    var remaining = 0;
    for (var i = 0; i < tasks.length; i++) {
      if (!tasks[i].done) remaining++;
    }

    if (total === 0) {
      counterEl.hidden = true; // пустой лист говорит сам за себя
    } else if (remaining === 0) {
      counterEl.hidden = false;
      counterEl.textContent = 'На сегодня всё. Можно выдохнуть';
      counterEl.classList.add('counter--done');
    } else {
      counterEl.hidden = false;
      counterEl.classList.remove('counter--done');
      var one = remaining % 10 === 1 && remaining % 100 !== 11;
      counterEl.textContent =
        (one ? 'Осталась ' : 'Осталось ') + remaining + ' ' +
        pluralize(remaining, ['задача', 'задачи', 'задач']);
    }

    emptyEl.hidden = total !== 0;
  }

  function renderAll() {
    listEl.textContent = ''; // безопасная очистка списка
    for (var i = 0; i < tasks.length; i++) {
      listEl.appendChild(createTaskItem(tasks[i]));
    }
    updateMeta();
  }

  /* ---------- События ---------- */

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    addTaskFromInput();
  });

  input.addEventListener('input', hideHint);

  // Отметка выполненной / возврат в невыполненные.
  listEl.addEventListener('change', function (event) {
    var checkbox = event.target;
    if (!checkbox || checkbox.type !== 'checkbox') return;
    var li = checkbox.closest('li.task-item');
    if (!li) return;

    var index = findTaskIndex(li.dataset.id);
    if (index === -1) return;

    tasks[index].done = checkbox.checked;
    li.classList.toggle('task-item--done', tasks[index].done);
    saveTasks();
    updateMeta();
  });

  // Удаление.
  listEl.addEventListener('click', function (event) {
    var button = event.target.closest('button.task-delete');
    if (!button) return;
    var li = button.closest('li.task-item');
    if (!li) return;
    deleteTask(li);
  });

  // Отмена удаления.
  undoBtn.addEventListener('click', undoDelete);

  /* ---------- Дата в шапке (только оформление) ---------- */

  function renderDate() {
    var now = new Date();
    var text = now.toLocaleDateString('ru-RU', {
      weekday: 'long',
      day: 'numeric',
      month: 'long'
    });
    todayEl.textContent = text.charAt(0).toUpperCase() + text.slice(1);
  }

  /* ---------- Запуск ---------- */

  tasks = loadTasks();
  renderAll();
  renderDate();
})();
