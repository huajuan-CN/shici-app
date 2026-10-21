(function () {
  "use strict";

  var DAYS = Array.isArray(window.CET4_DAYS) ? window.CET4_DAYS : [];
  var TOTAL_WORDS = DAYS.reduce(function (sum, day) { return sum + day.length; }, 0);
  var ALL_WORDS = [];
  var WORD_INDEX = new Map();

  DAYS.forEach(function (day, dayIndex) {
    day.forEach(function (word, wordIndex) {
      var item = Object.assign({}, word, { dayIndex: dayIndex, wordIndex: wordIndex });
      ALL_WORDS.push(item);
      WORD_INDEX.set(word.w.toLowerCase(), item);
    });
  });

  var KEYS = {
    learned: "shici_learned_v1",
    day: "shici_day_v1",
    theme: "shici_theme_v1",
    activity: "shici_activity_v1",
    shadow: "shici_shadow_v1",
    article: "shici_article_v1"
  };

  var $ = function (selector, root) { return (root || document).querySelector(selector); };
  var $$ = function (selector, root) { return Array.prototype.slice.call((root || document).querySelectorAll(selector)); };
  var icon = function (name, extraClass) {
    return '<svg class="icon ' + (extraClass || "") + '" aria-hidden="true"><use href="#i-' + name + '"></use></svg>';
  };
  var esc = function (value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (char) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
    });
  };
  var escapeRe = function (value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  };

  function readJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      return fallback;
    }
  }

  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      /* Storage may be disabled in private browsing. */
    }
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  var learned = new Set(readJSON(KEYS.learned, []));
  var activity = readJSON(KEYS.activity, {});
  var shadowLog = readJSON(KEYS.shadow, {});
  var savedDay = parseInt(localStorage.getItem(KEYS.day) || "1", 10);
  var currentDay = clamp(isNaN(savedDay) ? 0 : savedDay - 1, 0, Math.max(0, DAYS.length - 1));
  var currentView = "home";
  var toastTimer;
  var speechTimer;
  var installPrompt = null;
  var articleState = {
    word: readJSON(KEYS.article, {}).word || "",
    engine: readJSON(KEYS.article, {}).engine || "articles"
  };

  var libraryState = {
    query: "",
    filter: "all",
    count: 20,
    visible: []
  };

  var shadowState = {
    index: 0,
    recording: false,
    transcript: "",
    score: null
  };

  var quizState = {
    dayIndex: currentDay,
    count: 20,
    status: "ready",
    list: [],
    index: 0,
    correct: 0,
    wrong: [],
    revealed: false
  };

  function todayKey(date) {
    var d = date || new Date();
    var year = d.getFullYear();
    var month = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return year + "-" + month + "-" + day;
  }

  function dateFromKey(key) {
    var parts = key.split("-").map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }

  function shiftDate(date, amount) {
    var copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    copy.setDate(copy.getDate() + amount);
    return copy;
  }

  function markActivity(type) {
    var key = todayKey();
    activity[key] = activity[key] || {};
    activity[key][type] = true;
    writeJSON(KEYS.activity, activity);
    renderStreak();
  }

  function hasRecordedActivity(key) {
    var row = activity[key];
    var shadow = shadowLog[key];
    return Boolean((row && (row.word || row.shadow || row.quiz)) || (shadow && shadow.completed && shadow.completed.length));
  }

  function calculateStreak() {
    var cursor = new Date();
    if (!hasRecordedActivity(todayKey(cursor))) {
      cursor = shiftDate(cursor, -1);
    }
    var streak = 0;
    while (streak < 3660 && hasRecordedActivity(todayKey(cursor))) {
      streak++;
      cursor = shiftDate(cursor, -1);
    }
    return streak;
  }

  function calculateShadowStreak() {
    var cursor = new Date();
    var today = shadowLog[todayKey(cursor)];
    if (!today || !today.completed || !today.completed.length) {
      cursor = shiftDate(cursor, -1);
    }
    var streak = 0;
    while (streak < 3660) {
      var row = shadowLog[todayKey(cursor)];
      if (!row || !row.completed || !row.completed.length) break;
      streak++;
      cursor = shiftDate(cursor, -1);
    }
    return streak;
  }

  function currentDayWords() {
    return DAYS[currentDay] || [];
  }

  function learnedInDay(dayIndex) {
    return (DAYS[dayIndex] || []).filter(function (word) { return learned.has(word.w); }).length;
  }

  function shadowRowForToday(create) {
    var key = todayKey();
    var row = shadowLog[key];
    if (!row || row.day !== currentDay) {
      if (!create) {
        return { day: currentDay, completed: [], scores: {} };
      }
      row = { day: currentDay, completed: [], scores: {} };
      shadowLog[key] = row;
      writeJSON(KEYS.shadow, shadowLog);
    }
    row.completed = Array.isArray(row.completed) ? row.completed : [];
    row.scores = row.scores || {};
    return row;
  }

  function shadowSentences() {
    var words = currentDayWords().filter(function (word) { return word.e; });
    if (words.length <= 3) return words;
    var offset = currentDay % Math.max(1, words.length - 2);
    var pool = words.slice(offset).concat(words.slice(0, offset));
    return pool.slice(0, 3);
  }

  function setDay(dayIndex, options) {
    var next = clamp(dayIndex, 0, Math.max(0, DAYS.length - 1));
    if (next === currentDay && options && options.force !== true) {
      syncDayControls();
      return;
    }
    currentDay = next;
    try { localStorage.setItem(KEYS.day, String(currentDay + 1)); } catch (error) {}
    shadowState.index = 0;
    shadowState.score = null;
    shadowState.transcript = "";
    quizState.dayIndex = currentDay;
    resetQuiz();
    syncDayControls();
    renderHome();
    renderLibrary();
    renderArticles();
    renderShadowing();
    renderQuiz();
  }

  function showToast(message) {
    var toast = $("#toast");
    toast.textContent = message;
    toast.classList.add("is-visible");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      toast.classList.remove("is-visible");
    }, 2400);
  }

  function cancelSpeech() {
    window.clearTimeout(speechTimer);
    if ("speechSynthesis" in window) {
      try { window.speechSynthesis.cancel(); } catch (error) {}
    }
  }

  function speak(text, rate, onEnd) {
    if (!text || !("speechSynthesis" in window)) {
      showToast("当前浏览器不支持语音朗读");
      return;
    }
    try {
      cancelSpeech();
      var utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "en-US";
      utterance.rate = rate || 0.88;
      utterance.pitch = 1;
      if (typeof onEnd === "function") utterance.onend = onEnd;
      window.speechSynthesis.speak(utterance);
    } catch (error) {
      showToast("语音播放失败，请检查浏览器设置");
    }
  }

  function highlightWords(sentence, focusWords) {
    var safe = esc(sentence || "");
    var words = (focusWords || []).filter(Boolean).sort(function (a, b) { return b.length - a.length; });
    if (!words.length) return safe;
    var pattern = new RegExp("\\b(" + words.map(escapeRe).join("|") + ")\\b", "gi");
    return safe.replace(pattern, "<mark>$1</mark>");
  }

  function blankSentence(sentence, word) {
    if (!sentence) return "";
    var pattern = new RegExp("\\b" + escapeRe(word) + "\\b", "i");
    var match = pattern.exec(sentence);
    if (!match) return esc(sentence);
    var blank = "_".repeat(Math.max(6, word.length));
    return esc(sentence.slice(0, match.index)) +
      '<span class="blank">' + blank + "</span>" +
      esc(sentence.slice(match.index + match[0].length));
  }

  function renderStreak() {
    var streak = calculateStreak();
    $("#sidebarStreak").textContent = streak + " 天";
    $("#headerStreak").textContent = String(streak);
    $("#shadowStreak").textContent = calculateShadowStreak() + " 天";
  }

  function renderHome() {
    var words = currentDayWords();
    var now = new Date();
    var hour = now.getHours();
    var greeting = hour < 11 ? "早上好" : hour < 14 ? "中午好" : hour < 18 ? "下午好" : "晚上好";
    var dateText = new Intl.DateTimeFormat("zh-CN", {
      month: "long",
      day: "numeric",
      weekday: "long"
    }).format(now);
    var learnedCount = learnedInDay(currentDay);
    var progress = words.length ? Math.round(learnedCount / words.length * 100) : 0;
    var shadowCount = shadowRowForToday(false).completed.length;

    $("#homeDate").textContent = dateText.toUpperCase();
    $("#homeGreeting").textContent = greeting;
    $("#heroDay").textContent = String(currentDay + 1);
    $("#todayWordCount").textContent = String(words.length);
    $("#todayLearned").textContent = String(learnedCount);
    $("#todayShadow").textContent = Math.min(shadowCount, 3) + " / 3";
    $("#heroProgressFill").style.width = progress + "%";
    $("#heroProgressText").textContent = learnedCount + " / " + words.length + " 已掌握";

    $("#homeWords").innerHTML = words.slice(0, 4).map(function (word, index) {
      return '<button class="preview-word" data-home-word="' + esc(word.w) + '">' +
        "<span>" + String(index + 1).padStart(2, "0") + "</span>" +
        "<div><b>" + esc(word.w) + "</b><small>" + esc(word.m) + "</small></div>" +
        icon("volume") +
        "</button>";
    }).join("");

    var readingWords = words.slice(0, 3);
    var focus = readingWords.map(function (word) { return word.w; });
    $("#homeReading").innerHTML = highlightWords(readingWords.map(function (word) { return word.e; }).join(" "), focus);
    $("#homeReadingZh").textContent = readingWords.map(function (word) { return word.et; }).join(" ");
    renderStreak();
  }

  function syncDayControls() {
    $$("#daySelect, #quizDaySelect").forEach(function (select) {
      if (!select.options.length) {
        select.innerHTML = DAYS.map(function (_, index) {
          return '<option value="' + index + '">第 ' + (index + 1) + " 天 · " + DAYS[index].length + " 词</option>";
        }).join("");
      }
      select.value = String(currentDay);
    });
    $("#prevDayBtn").disabled = currentDay <= 0;
    $("#nextDayBtn").disabled = currentDay >= DAYS.length - 1;
    $("#quizPrevDay").disabled = currentDay <= 0;
    $("#quizNextDay").disabled = currentDay >= DAYS.length - 1;
  }

  function filteredWords() {
    var query = libraryState.query.trim().toLowerCase();
    var source = query ? ALL_WORDS : currentDayWords().map(function (word, index) {
      return Object.assign({}, word, { dayIndex: currentDay, wordIndex: index });
    });

    if (query) {
      source = source.filter(function (word) {
        return word.w.toLowerCase().indexOf(query) !== -1 ||
          String(word.m || "").toLowerCase().indexOf(query) !== -1;
      });
    }

    source = source.filter(function (word) {
      if (libraryState.filter === "new") return !learned.has(word.w);
      if (libraryState.filter === "done") return learned.has(word.w);
      return true;
    });

    if (query) {
      source.sort(function (a, b) {
        var aStarts = a.w.toLowerCase().indexOf(query) === 0 ? 0 : 1;
        var bStarts = b.w.toLowerCase().indexOf(query) === 0 ? 0 : 1;
        return aStarts - bStarts || a.w.length - b.w.length;
      });
    }

    return source;
  }

  function renderLibrary() {
    var allLearned = learned.size;
    $("#libraryTotalLearned").textContent = allLearned.toLocaleString("en-US");
    var filtered = filteredWords();
    var count = libraryState.count === "all" ? filtered.length : libraryState.count;
    var visible = filtered.slice(0, count);
    libraryState.visible = visible;

    var day = currentDayWords();
    $("#wordResultCount").textContent = libraryState.query
      ? "找到 " + filtered.length + " 个 · 显示 " + visible.length
      : "显示 " + visible.length + " / " + day.length;

    $("#wordsGrid").innerHTML = visible.map(function (word) {
      var isLearned = learned.has(word.w);
      var displayNumber = libraryState.query ? (word.dayIndex + 1) + "-" + (word.wordIndex + 1) : String(word.wordIndex + 1).padStart(2, "0");
      return '<article class="word-card' + (isLearned ? " is-learned" : "") + '" data-word="' + esc(word.w) + '">' +
        '<div class="word-card-top">' +
          '<span class="word-number">' + esc(displayNumber) + "</span>" +
          '<span class="word-pos">' + esc(word.p || "") + "</span>" +
          '<button class="mastery-button" data-action="mastery" aria-label="' + (isLearned ? "取消掌握" : "标记掌握") + '" title="' + (isLearned ? "取消掌握" : "标记掌握") + '">' +
            icon("check") +
          "</button>" +
        "</div>" +
        '<div class="word-main"><h3>' + esc(word.w) + '</h3><button class="speaker-button" data-action="speak" aria-label="朗读单词">' + icon("volume") + "</button></div>" +
        '<p class="word-meaning">' + esc(word.m || "") + "</p>" +
        '<button class="word-example-toggle" data-action="example">' + icon("book") + " 查看例句</button>" +
        '<div class="word-example"><p>' + highlightWords(word.e || "", [word.w]) + "</p><small>" + esc(word.et || "") + "</small></div>" +
      "</article>";
    }).join("");

    $("#wordsEmpty").hidden = visible.length > 0;
    $("#prevDayBtn").disabled = currentDay <= 0;
    $("#nextDayBtn").disabled = currentDay >= DAYS.length - 1;
    renderStreak();
  }

  function renderArticles() {
    var dayWords = currentDayWords();
    var defaultWord = dayWords[0] ? dayWords[0].w : "";
    if (!articleState.word) articleState.word = defaultWord;
    $("#articleWord").value = articleState.word;
    updateArticleLinks();

    $("#articleWordChips").innerHTML = dayWords.slice(0, 10).map(function (word) {
      return '<button data-article-word="' + esc(word.w) + '" class="' + (articleState.word.toLowerCase() === word.w.toLowerCase() ? "is-active" : "") + '">' + esc(word.w) + "</button>";
    }).join("");

    var featured = dayWords.slice(0, 4);
    var focus = featured.map(function (word) { return word.w; });
    $("#storyWords").innerHTML = featured.map(function (word) { return "<span>" + esc(word.w) + "</span>"; }).join("");
    $("#storyCopy").innerHTML = featured.map(function (word) {
      return "<p>" + highlightWords(word.e, focus) + "</p>";
    }).join("");
  }

  function articleUrl(word, engine) {
    var clean = (word || "").trim();
    if (!clean) return "";
    if (engine === "dictionary") {
      return "https://cn.bing.com/dict/search?q=" + encodeURIComponent(clean);
    }
    if (engine === "articles") {
      return "https://cn.bing.com/search?q=" + encodeURIComponent('"' + clean + '" 英语 学习 文章 语境');
    }
    return "https://cn.bing.com/news/search?q=" + encodeURIComponent('"' + clean + '" English');
  }

  function updateArticleLinks() {
    var word = $("#articleWord").value.trim() || articleState.word;
    var note = {
      news: "将打开必应中国新闻，查找与单词相关的报道。",
      articles: "将使用必应中国站，查找与单词相关的英语学习文章。",
      dictionary: "将打开必应中国词典，查看英文释义与例句。"
    };
    $("#articleSearchNote").textContent = note[articleState.engine];
    $$("#enginePicker button").forEach(function (button) {
      button.classList.toggle("is-active", button.getAttribute("data-engine") === articleState.engine);
    });

    var links = [
      { label: "必应新闻", url: articleUrl(word, "news") },
      { label: "必应文章", url: articleUrl(word, "articles") },
      { label: "必应词典", url: articleUrl(word, "dictionary") }
    ];
    $("#relatedLinks").innerHTML = links.map(function (link) {
      return '<a class="related-link" href="' + esc(link.url) + '" target="_blank" rel="noopener noreferrer">' +
        esc(link.label) + icon("external") + "</a>";
    }).join("");
  }

  function openArticleSearch() {
    var word = $("#articleWord").value.trim();
    if (!word) {
      $("#articleWord").focus();
      showToast("先输入一个想查的英文单词");
      return;
    }
    articleState.word = word;
    writeJSON(KEYS.article, articleState);
    window.open(articleUrl(word, articleState.engine), "_blank", "noopener,noreferrer");
  }

  function renderShadowing() {
    var sentences = shadowSentences();
    if (!sentences.length) return;
    shadowState.index = clamp(shadowState.index, 0, sentences.length - 1);
    var word = sentences[shadowState.index];
    var row = shadowRowForToday(true);
    var completed = row.completed.filter(function (item) {
      return sentences.some(function (sentence) { return sentence.w === item; });
    });
    row.completed = completed;
    writeJSON(KEYS.shadow, shadowLog);

    $("#shadowCounter").textContent = String(shadowState.index + 1).padStart(2, "0") + " / " + String(sentences.length).padStart(2, "0");
    $("#shadowFocusWord").textContent = word.w;
    $("#shadowSentence").innerHTML = highlightWords(word.e, [word.w]);
    $("#shadowTranslation").textContent = word.et || word.m;
    $("#shadowProgressNumber").textContent = completed.length + " / " + sentences.length;
    $("#shadowProgressFill").style.width = (completed.length / sentences.length * 100) + "%";
    $("#prevSentenceBtn").disabled = shadowState.index === 0;
    $("#nextSentenceBtn").disabled = shadowState.index === sentences.length - 1;
    $("#sentenceDots").innerHTML = sentences.map(function (sentence, index) {
      var done = completed.indexOf(sentence.w) !== -1;
      return '<button class="sentence-dot' + (index === shadowState.index ? " is-active" : "") +
        (done ? " is-done" : "") + '" data-sentence="' + index + '" aria-label="第 ' + (index + 1) + ' 句"></button>';
    }).join("");

    var savedScore = row.scores[word.w];
    if (shadowState.score == null && typeof savedScore === "number") shadowState.score = savedScore;
    updateShadowScoreUI(shadowState.score, shadowState.transcript);
    $("#manualDoneBtn").innerHTML = completed.indexOf(word.w) !== -1
      ? icon("check-circle") + " 已完成本轮"
      : icon("check") + " 完成本轮";
    renderStreak();
  }

  function goShadowSentence(index) {
    var sentences = shadowSentences();
    shadowState.index = clamp(index, 0, sentences.length - 1);
    shadowState.score = null;
    shadowState.transcript = "";
    updateShadowScoreUI(null, "");
    renderShadowing();
  }

  function updateShadowScoreUI(score, transcript) {
    var scoreLabel = typeof score === "number" ? score + " 分" : "等待录音";
    $("#matchScore").textContent = scoreLabel;
    $("#transcriptText").textContent = transcript || "点击“开始跟读”，读出上面的句子。浏览器会识别你的发音并给出参考分。";
    $("#scoreFill").style.width = (typeof score === "number" ? score : 0) + "%";
    $("#scoreFill").style.background = typeof score === "number" && score < 60 ? "var(--coral)" : "var(--green)";
  }

  function longestCommonSubsequence(a, b) {
    var row = new Array(b.length + 1).fill(0);
    for (var i = 1; i <= a.length; i++) {
      var previous = 0;
      for (var j = 1; j <= b.length; j++) {
        var old = row[j];
        row[j] = a[i - 1] === b[j - 1] ? previous + 1 : Math.max(row[j], row[j - 1]);
        previous = old;
      }
    }
    return row[b.length];
  }

  function speechScore(target, spoken, focusWord) {
    var targetTokens = (target.toLowerCase().match(/[a-z']+/g) || []);
    var spokenTokens = (spoken.toLowerCase().match(/[a-z']+/g) || []);
    if (!targetTokens.length || !spokenTokens.length) return 0;
    var match = longestCommonSubsequence(targetTokens, spokenTokens);
    var focusMatch = spokenTokens.indexOf(focusWord.toLowerCase()) !== -1;
    return clamp(Math.round((match / targetTokens.length) * 84 + (focusMatch ? 16 : 0)), 0, 100);
  }

  function completeShadowSentence(score) {
    var sentences = shadowSentences();
    var word = sentences[shadowState.index];
    var row = shadowRowForToday(true);
    if (row.completed.indexOf(word.w) === -1) row.completed.push(word.w);
    if (typeof score === "number") {
      row.scores[word.w] = Math.max(row.scores[word.w] || 0, score);
    }
    writeJSON(KEYS.shadow, shadowLog);
    markActivity("shadow");
    renderShadowing();
  }

  function setRecognitionState(text, listening) {
    var element = $("#recognitionState");
    element.innerHTML = "<i></i> " + esc(text);
    element.classList.toggle("is-listening", Boolean(listening));
  }

  function toggleRecording() {
    if (shadowState.recording && window.__shiciRecognition) {
      try { window.__shiciRecognition.stop(); } catch (error) {}
      return;
    }

    var Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      setRecognitionState("此浏览器不支持自动评分", false);
      showToast("可先听原句跟读，再点“完成本轮”记录练习");
      return;
    }

    var sentences = shadowSentences();
    var item = sentences[shadowState.index];
    var recognition = new Recognition();
    window.__shiciRecognition = recognition;
    recognition.lang = "en-US";
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;
    shadowState.transcript = "";
    shadowState.score = null;
    updateShadowScoreUI(null, "正在聆听，请读出整句…");

    recognition.onstart = function () {
      shadowState.recording = true;
      $("#recordBtn").classList.add("is-recording");
      $("#recordBtnLabel").textContent = "停止录音";
      setRecognitionState("正在聆听…", true);
    };

    recognition.onresult = function (event) {
      var transcript = "";
      for (var i = 0; i < event.results.length; i++) transcript += event.results[i][0].transcript + " ";
      shadowState.transcript = transcript.trim();
      $("#transcriptText").textContent = shadowState.transcript || "正在聆听…";
    };

    recognition.onerror = function (event) {
      shadowState.recording = false;
      $("#recordBtn").classList.remove("is-recording");
      $("#recordBtnLabel").textContent = "开始跟读";
      setRecognitionState(event.error === "not-allowed" ? "需要麦克风权限" : "识别未完成", false);
      if (event.error === "not-allowed") {
        showToast("请在浏览器设置中允许麦克风权限");
      } else if (event.error !== "no-speech" && event.error !== "aborted") {
        showToast("语音识别暂时不可用，可以直接点“完成本轮”");
      }
    };

    recognition.onend = function () {
      shadowState.recording = false;
      $("#recordBtn").classList.remove("is-recording");
      $("#recordBtnLabel").textContent = "再读一次";
      setRecognitionState("识别完成", false);
      if (shadowState.transcript) {
        shadowState.score = speechScore(item.e, shadowState.transcript, item.w);
        updateShadowScoreUI(shadowState.score, shadowState.transcript);
        if (shadowState.score >= 55) {
          completeShadowSentence(shadowState.score);
          showToast("跟读完成，参考分 " + shadowState.score);
        } else {
          showToast("已经听见了，再慢一点读一遍会更清楚");
        }
      }
      window.__shiciRecognition = null;
    };

    try {
      recognition.start();
    } catch (error) {
      shadowState.recording = false;
      showToast("麦克风启动失败，请稍后再试");
    }
  }

  function resetQuiz() {
    quizState.dayIndex = currentDay;
    quizState.status = "ready";
    quizState.list = [];
    quizState.index = 0;
    quizState.correct = 0;
    quizState.wrong = [];
    quizState.revealed = false;
  }

  function startQuiz() {
    var dayWords = DAYS[currentDay] || [];
    quizState.dayIndex = currentDay;
    quizState.list = dayWords.slice(0, quizState.count);
    quizState.index = 0;
    quizState.correct = 0;
    quizState.wrong = [];
    quizState.revealed = false;
    quizState.status = quizState.list.length ? "playing" : "ready";
    renderQuiz();
  }

  function renderQuizAside() {
    var answered = quizState.status === "summary"
      ? quizState.list.length
      : quizState.index + (quizState.revealed ? 1 : 0);
    var accuracy = answered ? Math.round(quizState.correct / answered * 100) : 0;
    $("#quizAccuracy").textContent = answered ? accuracy + "%" : "—";
    $("#quizCorrect").textContent = String(quizState.correct);
    $("#quizRemaining").textContent = String(Math.max(0, (quizState.list.length || quizState.count) - answered));
  }

  function renderQuiz() {
    var card = $("#quizCard");
    if (!DAYS.length) {
      card.innerHTML = '<div class="empty-state"><strong>未找到词汇数据</strong><span>请确认 words.js 与应用文件位于同一目录。</span></div>';
      return;
    }

    if (quizState.dayIndex !== currentDay) resetQuiz();

    if (quizState.status === "ready") {
      card.innerHTML = '<div class="quiz-ready">' +
        '<span class="quiz-ready-icon">' + icon("pen") + "</span>" +
        "<h2>准备好了吗？</h2>" +
        "<p>本轮从第 " + (currentDay + 1) + " 天词单中抽取 " + quizState.count + " 个单词。可以随时看答案，重点是把词从记忆里找回来。</p>" +
        '<button class="button primary" data-quiz-action="start">开始默写 ' + icon("arrow") + "</button>" +
        "</div>";
      renderQuizAside();
      return;
    }

    if (quizState.status === "summary") {
      var total = quizState.list.length;
      var accuracy = total ? Math.round(quizState.correct / total * 100) : 0;
      var wrongHtml = quizState.wrong.length
        ? '<div class="wrong-list">' + quizState.wrong.map(function (word) {
            return '<div class="wrong-word"><b>' + esc(word.w) + "</b><span>" + esc(word.m) +
              '</span><button class="speaker-button" data-quiz-action="speak" data-word="' + esc(word.w) + '" aria-label="朗读">' + icon("volume") + "</button></div>";
          }).join("") + "</div>"
        : '<p class="summary-sub">这一轮没有答错的单词。</p>';
      card.innerHTML = '<div class="quiz-summary">' +
        '<span class="summary-icon">' + icon(accuracy >= 80 ? "check-circle" : "sparkles") + "</span>" +
        "<h2>本轮完成</h2>" +
        '<div class="summary-score">' + accuracy + "%</div>" +
        '<p class="summary-sub">答对 ' + quizState.correct + " / " + total + " 个单词</p>" +
        wrongHtml +
        '<div class="quiz-actions">' +
          (quizState.wrong.length ? '<button class="button primary" data-quiz-action="retry">重做错词</button>' : "") +
          '<button class="button secondary" data-quiz-action="restart">' + icon("rotate") + " 再测一轮</button>" +
        "</div>" +
        "</div>";
      renderQuizAside();
      return;
    }

    if (quizState.index >= quizState.list.length) {
      quizState.status = "summary";
      markActivity("quiz");
      renderQuiz();
      return;
    }

    var word = quizState.list[quizState.index];
    var feedback = "";
    if (quizState.revealed) {
      var correct = quizState.lastCorrect;
      feedback = correct
        ? '<div class="quiz-feedback is-good">' + icon("check-circle") + "<span>正确 · <strong>" + esc(word.w) + "</strong></span></div>"
        : '<div class="quiz-feedback is-bad">' + icon("x") + "<span>正确答案 · <strong>" + esc(word.w) + "</strong></span></div>";
    }
    card.innerHTML =
      '<div class="quiz-topline">' +
        '<span class="quiz-question-count">' + String(quizState.index + 1).padStart(2, "0") + " / " + String(quizState.list.length).padStart(2, "0") + "</span>" +
        '<span class="quiz-pos">' + esc(word.p || "") + "</span>" +
        '<button class="speaker-button" data-quiz-action="speak" data-word="' + esc(word.w) + '" aria-label="听发音" style="margin-left:auto">' + icon("volume") + "</button>" +
      "</div>" +
      '<div class="quiz-bar"><i style="width:' + (quizState.index / quizState.list.length * 100) + '%"></i></div>' +
      '<div class="quiz-prompt">' +
        "<span>根据释义拼出英文单词</span>" +
        '<h2 class="quiz-meaning">' + esc(word.m) + "</h2>" +
        '<div class="quiz-example">' + blankSentence(word.e || "", word.w) + "</div>" +
      "</div>" +
      '<div class="quiz-input-wrap' + (quizState.revealed ? (quizState.lastCorrect ? " is-correct" : " is-wrong") : "") + '">' +
        '<input id="quizAnswer" type="text" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" ' +
          (quizState.revealed ? "disabled " : "") +
          'placeholder="输入英文单词" aria-label="英文单词答案">' +
        '<span class="quiz-input-hint">ENTER 提交</span>' +
      "</div>" +
      feedback +
      '<div class="quiz-actions">' +
        (quizState.revealed
          ? '<button class="button primary" data-quiz-action="next">' + (quizState.index + 1 >= quizState.list.length ? "查看成绩" : "下一题") + " " + icon("arrow") + "</button>"
          : '<button class="button primary" data-quiz-action="submit">提交答案</button><button class="button ghost" data-quiz-action="peek">看答案</button>') +
      "</div>";
    renderQuizAside();
    if (!quizState.revealed) {
      window.setTimeout(function () {
        var input = $("#quizAnswer");
        if (input && document.querySelector("#view-quiz.is-active")) input.focus();
      }, 30);
    }
  }

  function submitQuiz() {
    if (quizState.status !== "playing" || quizState.revealed) return;
    var input = $("#quizAnswer");
    if (!input) return;
    var answer = input.value.trim().toLowerCase();
    if (!answer) {
      input.focus();
      showToast("先输入一个答案");
      return;
    }
    var word = quizState.list[quizState.index];
    quizState.lastCorrect = answer === word.w.toLowerCase();
    quizState.revealed = true;
    if (quizState.lastCorrect) {
      quizState.correct++;
    } else if (!quizState.wrong.some(function (item) { return item.w === word.w; })) {
      quizState.wrong.push(word);
    }
    markActivity("quiz");
    renderQuiz();
  }

  function peekQuiz() {
    if (quizState.status !== "playing" || quizState.revealed) return;
    var word = quizState.list[quizState.index];
    quizState.lastCorrect = false;
    quizState.revealed = true;
    if (!quizState.wrong.some(function (item) { return item.w === word.w; })) quizState.wrong.push(word);
    markActivity("quiz");
    renderQuiz();
  }

  function nextQuiz() {
    if (quizState.index >= quizState.list.length - 1) {
      quizState.index = quizState.list.length;
      quizState.status = "summary";
      renderQuiz();
      return;
    }
    quizState.index++;
    quizState.revealed = false;
    quizState.lastCorrect = false;
    renderQuiz();
  }

  function retryWrongQuiz() {
    quizState.list = quizState.wrong.slice();
    quizState.wrong = [];
    quizState.index = 0;
    quizState.correct = 0;
    quizState.revealed = false;
    quizState.lastCorrect = false;
    quizState.status = "playing";
    renderQuiz();
  }

  function renderAll() {
    syncDayControls();
    renderHome();
    renderLibrary();
    renderArticles();
    renderShadowing();
    renderQuiz();
    renderStreak();
  }

  function goToView(view, options) {
    if (!document.getElementById("view-" + view)) view = "home";
    if (currentView === "shadowing" && view !== "shadowing") {
      cancelSpeech();
      if (shadowState.recording && window.__shiciRecognition) {
        try { window.__shiciRecognition.abort(); } catch (error) {}
      }
    }
    currentView = view;
    $$(".view").forEach(function (element) {
      element.classList.toggle("is-active", element.id === "view-" + view);
    });
    $$("[data-view]").forEach(function (button) {
      button.classList.toggle("is-active", button.getAttribute("data-view") === view);
    });
    document.title = ($("#view-" + view).getAttribute("data-title") || "英语学习") + " · 拾词";
    if (!options || !options.skipHash) {
      try { history.replaceState(null, "", "#" + view); } catch (error) { location.hash = view; }
    }
    window.scrollTo({ top: 0, behavior: "auto" });

    if (view === "home") renderHome();
    if (view === "library") renderLibrary();
    if (view === "articles") renderArticles();
    if (view === "shadowing") renderShadowing();
    if (view === "quiz") renderQuiz();
  }

  function toggleTheme() {
    var dark = !document.body.classList.contains("dark");
    document.body.classList.toggle("dark", dark);
    try { localStorage.setItem(KEYS.theme, dark ? "dark" : "light"); } catch (error) {}
  }

  function bindEvents() {
    document.addEventListener("click", function (event) {
      var navButton = event.target.closest("[data-view]");
      if (navButton) goToView(navButton.getAttribute("data-view"));

      var goButton = event.target.closest("[data-go]");
      if (goButton) {
        event.preventDefault();
        goToView(goButton.getAttribute("data-go"));
      }
    });

    $("#themeBtn").addEventListener("click", toggleTheme);
    $("#mobileThemeBtn").addEventListener("click", toggleTheme);

    $("#prevDayBtn").addEventListener("click", function () { setDay(currentDay - 1); });
    $("#nextDayBtn").addEventListener("click", function () { setDay(currentDay + 1); });
    $("#quizPrevDay").addEventListener("click", function () { setDay(currentDay - 1); });
    $("#quizNextDay").addEventListener("click", function () { setDay(currentDay + 1); });
    $$("#daySelect, #quizDaySelect").forEach(function (select) {
      select.addEventListener("change", function () { setDay(parseInt(select.value, 10)); });
    });

    $("#wordSearch").addEventListener("input", function (event) {
      libraryState.query = event.target.value;
      renderLibrary();
    });

    $("#wordFilters").addEventListener("click", function (event) {
      var button = event.target.closest("[data-filter]");
      if (!button) return;
      libraryState.filter = button.getAttribute("data-filter");
      $$("#wordFilters .chip").forEach(function (chip) { chip.classList.toggle("is-active", chip === button); });
      renderLibrary();
    });

    $(".word-toolbar .count-picker").addEventListener("click", function (event) {
      var button = event.target.closest("[data-count]");
      if (!button) return;
      var value = button.getAttribute("data-count");
      libraryState.count = value === "all" ? "all" : parseInt(value, 10);
      $$(".word-toolbar .count-chip").forEach(function (chip) {
        chip.classList.toggle("is-active", Number(chip.getAttribute("data-count")) === libraryState.count || chip.getAttribute("data-count") === value);
      });
      renderLibrary();
    });

    $("#wordsGrid").addEventListener("click", function (event) {
      var card = event.target.closest(".word-card");
      if (!card) return;
      var word = WORD_INDEX.get(card.getAttribute("data-word").toLowerCase());
      if (!word) return;
      var action = event.target.closest("[data-action]");
      if (action && action.getAttribute("data-action") === "speak") {
        speak(word.w);
        return;
      }
      if (action && action.getAttribute("data-action") === "mastery") {
        if (learned.has(word.w)) {
          learned.delete(word.w);
          showToast("已取消掌握：" + word.w);
        } else {
          learned.add(word.w);
          markActivity("word");
          showToast("已掌握：" + word.w);
        }
        writeJSON(KEYS.learned, Array.from(learned));
        renderLibrary();
        renderHome();
        return;
      }
      if (action && action.getAttribute("data-action") === "example") {
        card.classList.toggle("is-open");
        action.innerHTML = icon("book") + (card.classList.contains("is-open") ? " 收起例句" : " 查看例句");
      }
    });

    $("#homeWords").addEventListener("click", function (event) {
      var button = event.target.closest("[data-home-word]");
      if (button) speak(button.getAttribute("data-home-word"));
    });
    $("#homeReadBtn").addEventListener("click", function () {
      speak(currentDayWords().slice(0, 3).map(function (word) { return word.e; }).join(" "), 0.86);
    });

    $("#articleForm").addEventListener("submit", function (event) {
      event.preventDefault();
      openArticleSearch();
    });
    $("#articleWord").addEventListener("input", function (event) {
      articleState.word = event.target.value.trim();
      updateArticleLinks();
    });
    $("#enginePicker").addEventListener("click", function (event) {
      var button = event.target.closest("[data-engine]");
      if (!button) return;
      articleState.engine = button.getAttribute("data-engine");
      writeJSON(KEYS.article, articleState);
      updateArticleLinks();
    });
    $("#articleWordChips").addEventListener("click", function (event) {
      var button = event.target.closest("[data-article-word]");
      if (!button) return;
      articleState.word = button.getAttribute("data-article-word");
      $("#articleWord").value = articleState.word;
      writeJSON(KEYS.article, articleState);
      renderArticles();
    });
    $("#storyPlayBtn").addEventListener("click", function () {
      speak(currentDayWords().slice(0, 4).map(function (word) { return word.e; }).join(" "), 0.9);
    });
    $("#storySlowerBtn").addEventListener("click", function () {
      speak(currentDayWords().slice(0, 4).map(function (word) { return word.e; }).join(" "), 0.68);
    });

    $("#listenSentenceBtn").addEventListener("click", function () {
      var sentence = shadowSentences()[shadowState.index];
      if (sentence) speak(sentence.e, 0.88);
    });
    $("#slowSentenceBtn").addEventListener("click", function () {
      var sentence = shadowSentences()[shadowState.index];
      if (sentence) speak(sentence.e, 0.64);
    });
    $("#shadowWordSpeak").addEventListener("click", function () {
      speak($("#shadowFocusWord").textContent, 0.86);
    });
    $("#prevSentenceBtn").addEventListener("click", function () { goShadowSentence(shadowState.index - 1); });
    $("#nextSentenceBtn").addEventListener("click", function () { goShadowSentence(shadowState.index + 1); });
    $("#sentenceDots").addEventListener("click", function (event) {
      var button = event.target.closest("[data-sentence]");
      if (button) goShadowSentence(parseInt(button.getAttribute("data-sentence"), 10));
    });
    $("#recordBtn").addEventListener("click", toggleRecording);
    $("#manualDoneBtn").addEventListener("click", function () {
      var sentence = shadowSentences()[shadowState.index];
      completeShadowSentence(shadowState.score);
      showToast("已记录：" + sentence.w);
      if (shadowState.index < shadowSentences().length - 1) {
        window.setTimeout(function () { goShadowSentence(shadowState.index + 1); }, 420);
      }
    });

    $("#quizCard").addEventListener("click", function (event) {
      var action = event.target.closest("[data-quiz-action]");
      if (!action) return;
      var type = action.getAttribute("data-quiz-action");
      if (type === "speak") speak(action.getAttribute("data-word"));
      if (type === "start" || type === "restart") startQuiz();
      if (type === "submit") submitQuiz();
      if (type === "peek") peekQuiz();
      if (type === "next") nextQuiz();
      if (type === "retry") retryWrongQuiz();
    });

    $("#quizCard").addEventListener("keydown", function (event) {
      if (event.key === "Enter" && event.target.id === "quizAnswer") {
        event.preventDefault();
        submitQuiz();
      }
    });

    $("#quizCountPicker").addEventListener("click", function (event) {
      var button = event.target.closest("[data-count]");
      if (!button) return;
      quizState.count = parseInt(button.getAttribute("data-count"), 10);
      $$("#quizCountPicker .count-chip").forEach(function (chip) { chip.classList.toggle("is-active", chip === button); });
      resetQuiz();
      renderQuiz();
    });

    document.addEventListener("keydown", function (event) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        goToView("library");
        window.setTimeout(function () { $("#wordSearch").focus(); }, 50);
      }
    });

    window.addEventListener("hashchange", function () {
      var view = location.hash.replace("#", "") || "home";
      if (view !== currentView) goToView(view, { skipHash: true });
    });

    window.addEventListener("beforeinstallprompt", function (event) {
      event.preventDefault();
      installPrompt = event;
      $("#installBtn").hidden = false;
    });

    $("#installBtn").addEventListener("click", function () {
      if (!installPrompt) {
        showToast("在浏览器菜单中选择“添加到主屏幕”即可安装");
        return;
      }
      installPrompt.prompt();
      installPrompt.userChoice.then(function () {
        installPrompt = null;
        $("#installBtn").hidden = true;
      });
    });
  }

  function registerServiceWorker() {
    if ("serviceWorker" in navigator && location.protocol !== "file:") {
      window.addEventListener("load", function () {
        navigator.serviceWorker.register("./sw.js").catch(function () {});
      });
    }
  }

  function init() {
    if (localStorage.getItem(KEYS.theme) === "dark") document.body.classList.add("dark");
    bindEvents();
    renderAll();
    var initial = location.hash.replace("#", "") || "home";
    goToView(initial, { skipHash: true });
    registerServiceWorker();
  }

  init();
})();
