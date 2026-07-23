const sampleScript = "清晨，一位年轻上班族骑着新能源电动车穿过城市街道。车辆启动平稳，行驶安静，智能仪表清晰显示速度和电量。镜头展现车辆外观、驾驶体验和城市通勤场景，突出轻便、安全、智能的产品特点。最后，主人公到达办公楼前，轻松停车，画面出现品牌口号。";
const STORAGE_KEY = "ai-storyboard-projects-v1";
const DEFAULT_TONE = "自然真实色调、中低对比度、自然肤色色调";
const DEFAULT_VISUAL_STYLE = "真实电影摄影风格、高端TVC广告风格、都市生活方式风格";
const LOOK_FIELDS = {
  visualStyle: { max: 3, empty: "拆解分镜后由 AI 推荐整体风格，也可以手动新增。" },
  tone: { max: 3, empty: "拆解分镜后由 AI 推荐整体色调，也可以手动新增。" },
};
const DEFAULT_PROJECT = {
  name: "30秒新能源电动车广告",
  type: "广告片",
  duration: 30,
  aspect: "9:16 竖屏",
  style: "真实电影摄影风格、都市生活方式风格",
  platform: "抖音",
};
const MAX_SHOT_COUNT = 1200;

const state = {
  projectId: "",
  currentUser: null,
  screen: "login",
  project: { ...DEFAULT_PROJECT },
  detected: emptyDetected(),
  includeDialogue: true,
  includeNarration: true,
  shots: [],
  boardsGenerated: false,
  hydrating: false,
  saveTimer: 0,
};

const $ = (id) => document.querySelector(id);
const els = {
  loginPage: $("#loginPage"), platformShell: $("#platformShell"),
  dashboard: $("#dashboard"), setup: $("#setup"), workbench: $("#workbench"),
  projectList: $("#projectList"),
  projectName: $("#projectName"), projectType: $("#projectType"), duration: $("#duration"), workbenchDuration: $("#workbenchDuration"), aspect: $("#aspect"), style: $("#style"), platform: $("#platform"),
  scriptInput: $("#scriptInput"), globalNotes: $("#globalNotes"), shotTarget: $("#shotTarget"),
  uploadBox: $("#uploadBox"), fileInput: $("#fileInput"), fileStatus: $("#fileStatus"),
  analysisGrid: $("#analysisGrid"), shots: $("#shots"), boards: $("#boards"),
  shotCount: $("#shotCount"), confirmedCount: $("#confirmedCount"), boardCount: $("#boardCount"), summary: $("#summary"), notice: $("#notice"),
  boardStyle: $("#boardStyle"), tone: $("#tone"), visualStyle: $("#visualStyle"), creativity: $("#creativity"),
  creativityText: $("#creativityText"), creativityValue: $("#creativityValue"), apiDialog: $("#apiDialog"), toast: $("#toast"),
  apiProvider: $("#apiProvider"), apiBaseUrl: $("#apiBaseUrl"), apiKey: $("#apiKey"), apiTextModel: $("#apiTextModel"),
  apiImageModel: $("#apiImageModel"), apiTemperature: $("#apiTemperature"), apiStatus: $("#apiStatus"),
  authBtn: $("#authBtn"), authForm: $("#authForm"), authName: $("#authName"), authEmail: $("#authEmail"),
  authPassword: $("#authPassword"), authStatus: $("#authStatus"), loginBtn: $("#loginBtn"), registerBtn: $("#registerBtn"),
  logoutBtn: $("#logoutBtn"),
};

function emptyDetected() {
  return { people: [], product: [], locations: [], props: [], times: [], sellingPoints: [], dialogue: [], narration: [] };
}

function showToast(text) {
  els.toast.textContent = text;
  els.toast.classList.add("show");
  setTimeout(() => els.toast.classList.remove("show"), 2200);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function canUseBackend() {
  return window.location.protocol !== "file:";
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[m]);
}

function unique(items) {
  return [...new Set(items.map((x) => String(x || "").trim()).filter(Boolean))];
}

function parseList(text) {
  return unique(String(text || "").split(/[\n,，、;；]/));
}

function parseTagList(text, max = Infinity) {
  return unique(String(text || "").split(/[\n,，、;；+＋]/)).slice(0, max);
}

function tagText(value, max = Infinity) {
  return parseTagList(value, max).join("、");
}

function listText(items, fallback = "待补充") {
  return items.length ? items.join("、") : fallback;
}

function isAuthError(error) {
  return Number(error?.status || 0) === 401;
}

function first(items, fallback) {
  return items[0] || fallback;
}

function requestedShotCount() {
  const value = Number(els.shotTarget?.value || "");
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(MAX_SHOT_COUNT, Math.max(1, Math.round(value)));
}

function suggestShotCount() {
  const script = els.scriptInput.value.trim();
  const units = scriptUnits(script, MAX_SHOT_COUNT);
  const duration = readProjectDuration();
  const entityCount = ["people", "locations", "props", "product"].reduce((sum, key) => sum + (state.detected[key] || []).length, 0);
  let min = 4;
  let max = 8;
  let ideal = Math.round(duration * 0.6);
  if (duration <= 10) {
    min = 4; max = 8; ideal = Math.round(duration * 0.6);
  } else if (duration <= 15) {
    min = 6; max = 10; ideal = Math.round(duration * 0.6);
  } else if (duration <= 30) {
    min = 10; max = 18; ideal = Math.round(duration * 0.45);
  } else if (duration <= 60) {
    min = 18; max = 35; ideal = Math.round(duration * 0.42);
  } else if (duration <= 120) {
    min = Math.round(duration / 2.8);
    max = Math.round(duration / 1.6);
    ideal = Math.round(duration / 2);
  } else {
    min = Math.round(duration / 6);
    max = Math.round(duration / 2.5);
    ideal = Math.round(duration / 4.5);
  }
  const densityBonus = entityCount >= 8 ? 2 : entityCount >= 5 ? 1 : 0;
  const textDensity = Math.ceil(script.length / 80);
  const unitBased = Math.max(units.length, textDensity);
  const densityWeight = duration > 60 ? 0.08 : 0.3;
  const blended = Math.round(ideal * (1 - densityWeight) + Math.min(max, unitBased) * densityWeight) + densityBonus;
  return Math.min(MAX_SHOT_COUNT, Math.max(min, Math.min(max + densityBonus, blended)));
}

function applySuggestedShotCount() {
  const count = suggestShotCount();
  if (els.shotTarget) els.shotTarget.value = count;
  return count;
}

function normalizeCreativityValue(value, scale = 100) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 60;
  if (scale !== 100 && numeric >= 0 && numeric <= 3) return [0, 35, 60, 85][Math.round(numeric)] ?? 60;
  return Math.min(100, Math.max(0, Math.round(numeric)));
}

function creativityLabel(value = els.creativity?.value) {
  const level = normalizeCreativityValue(value, 100);
  if (level <= 20) return `当前：${level}/100 · 保守拆解`;
  if (level <= 45) return `当前：${level}/100 · 稳妥优化`;
  if (level <= 75) return `当前：${level}/100 · 平衡发挥`;
  return `当前：${level}/100 · 脑洞更大`;
}

function updateCreativityUi() {
  const value = normalizeCreativityValue(els.creativity?.value, 100);
  if (els.creativity) els.creativity.value = value;
  if (els.creativityValue) els.creativityValue.textContent = value;
  if (els.creativityText) els.creativityText.textContent = creativityLabel(value);
}

function readProjectDuration() {
  const source = state.screen === "workbench" && els.workbenchDuration?.value
    ? els.workbenchDuration.value
    : els.duration.value;
  const value = Number(source || 30);
  return Number.isFinite(value) ? Math.max(1, Math.round(value)) : 30;
}

function syncDurationInputs(value) {
  const duration = Number.isFinite(Number(value)) ? Math.max(1, Math.round(Number(value))) : 30;
  if (els.duration) els.duration.value = duration;
  if (els.workbenchDuration) els.workbenchDuration.value = duration;
}

function syncChoiceButtons(targetId) {
  const input = $(`#${targetId}`);
  if (!input) return;
  const values = parseTagList(input.value);
  document.querySelectorAll(`[data-choice-group][data-target="${targetId}"] .choice-pill`).forEach((button) => {
    button.classList.toggle("active", values.includes(button.dataset.choiceValue));
  });
}

function syncAllChoiceButtons() {
  ["projectType", "aspect", "style", "platform", "tone", "visualStyle"].forEach(syncChoiceButtons);
}

function normalizeTagInput(input, max = Infinity) {
  if (!input) return;
  input.value = tagText(input.value, max);
  syncChoiceButtons(input.id);
}

function handleChoiceButton(button) {
  const group = button.closest("[data-choice-group]");
  if (!group) return;
  const input = $(`#${group.dataset.target}`);
  if (!input) return;
  const mode = group.dataset.mode || "single";
  const value = button.dataset.choiceValue;
  if (mode === "single") {
    input.value = value;
  } else {
    const max = Number(group.dataset.max || 0);
    const values = parseTagList(input.value);
    const exists = values.includes(value);
    if (exists) {
      input.value = values.filter((item) => item !== value).join("、");
    } else {
      if (max && values.length >= max) {
        showToast(`最多选择 ${max} 个标签。`);
        return;
      }
      input.value = [...values, value].join("、");
    }
  }
  syncChoiceButtons(input.id);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function lookInput(field) {
  if (field === "visualStyle") return els.visualStyle;
  if (field === "tone") return els.tone;
  return null;
}

function lookValues(field) {
  const config = LOOK_FIELDS[field] || { max: 3 };
  return parseTagList(lookInput(field)?.value || "", config.max);
}

function setLookValues(field, values, shouldSave = false) {
  const input = lookInput(field);
  const config = LOOK_FIELDS[field] || { max: 3 };
  if (!input) return;
  input.value = unique(values).slice(0, config.max).join("、");
  renderLookTagEditor(field);
  if (shouldSave) scheduleAutoSave();
}

function renderLookTagEditor(field) {
  const list = document.querySelector(`[data-tag-list="${field}"]`);
  if (!list) return;
  const values = lookValues(field);
  if (!values.length) {
    list.innerHTML = `<span class="look-tag empty">${esc(LOOK_FIELDS[field]?.empty || "暂无标签")}</span>`;
    return;
  }
  list.innerHTML = values.map((value) => `
    <span class="look-tag">${esc(value)}<button type="button" title="删除标签" data-tag-remove="${field}" data-tag-value="${esc(value)}">×</button></span>
  `).join("");
}

function renderLookTagEditors() {
  Object.keys(LOOK_FIELDS).forEach(renderLookTagEditor);
}

function addLookTag(field) {
  const input = document.querySelector(`[data-tag-input="${field}"]`);
  const config = LOOK_FIELDS[field] || { max: 3 };
  const next = parseTagList(input?.value || "", config.max);
  if (!next.length) return showToast("请先输入要新增的标签。");
  const values = lookValues(field);
  const merged = unique([...values, ...next]);
  if (merged.length > config.max) {
    showToast(`最多保留 ${config.max} 个标签，请先删除一个再新增。`);
    return;
  }
  if (input) input.value = "";
  setLookValues(field, merged, true);
}

function newProjectId() {
  return `project-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function projectStorageKey() {
  return `${STORAGE_KEY}:${state.currentUser?.id || "guest"}`;
}

function loadSavedProjects() {
  try {
    const data = JSON.parse(localStorage.getItem(projectStorageKey()) || "[]");
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeSavedProjects(projects) {
  try {
    localStorage.setItem(projectStorageKey(), JSON.stringify(projects.slice(0, 30)));
  } catch (error) {
    console.warn(error);
    showToast("本地保存空间不足：图片只用于当前页面和导出，不写入项目存储。");
  }
}

function mergeProjects(localProjects, remoteProjects) {
  const map = new Map();
  [...remoteProjects, ...localProjects].forEach((item) => {
    if (!item || !item.id) return;
    const existing = map.get(item.id);
    if (!existing || String(item.updatedAt || "") > String(existing.updatedAt || "")) map.set(item.id, item);
  });
  return [...map.values()].sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}

function hasProjectContent() {
  return Boolean(
    state.projectId
    || els.scriptInput.value.trim()
    || els.globalNotes.value.trim()
    || state.shots.length
    || Object.values(state.detected).some((items) => Array.isArray(items) && items.length)
  );
}

function projectSnapshot() {
  const overallColorTone = tagText(els.tone.value, 3);
  const overallVisualStyle = tagText(els.visualStyle.value, 3);
  const savedShots = state.shots.map((shot) => ({
    ...shot,
    refData: "",
    boardImage: "",
    boardWarning: shot.boardWarning || "",
    boardSource: shot.boardSource || "",
    boardModel: shot.boardModel || "",
  }));
  return {
    id: state.projectId || newProjectId(),
    updatedAt: new Date().toISOString(),
    project: { ...state.project },
    script: els.scriptInput.value,
    globalNotes: els.globalNotes.value,
    shotTarget: els.shotTarget.value,
    detected: normalizeAnalysisData(state.detected),
    includeDialogue: true,
    includeNarration: true,
    shots: savedShots,
    boardsGenerated: state.boardsGenerated,
    boardStyle: els.boardStyle.value,
    tone: overallColorTone,
    visualStyle: overallVisualStyle,
    overallColorTone,
    overallVisualStyle,
    creativity: els.creativity.value,
    creativityScale: 100,
  };
}

function saveCurrentProject() {
  if (state.hydrating || !hasProjectContent()) return;
  const snapshot = projectSnapshot();
  state.projectId = snapshot.id;
  const projects = loadSavedProjects().filter((item) => item.id !== snapshot.id);
  writeSavedProjects([snapshot, ...projects]);
  saveRemoteProject(snapshot);
  renderDashboard();
}

async function saveRemoteProject(snapshot) {
  if (!state.currentUser || !canUseBackend()) return;
  try {
    await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(snapshot),
    });
  } catch (error) {
    console.warn(error);
  }
}

async function deleteRemoteProject(projectId) {
  if (!state.currentUser || !canUseBackend()) return;
  try {
    await fetch(`/api/projects?id=${encodeURIComponent(projectId)}`, { method: "DELETE" });
  } catch (error) {
    console.warn(error);
  }
}

async function loadRemoteProjects() {
  if (!state.currentUser || !canUseBackend()) return;
  try {
    const response = await fetch("/api/projects");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "读取项目失败");
    writeSavedProjects(mergeProjects(loadSavedProjects(), data.projects || []));
    renderDashboard();
  } catch (error) {
    console.warn(error);
  }
}

function scheduleAutoSave() {
  if (state.hydrating) return;
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveCurrentProject, 500);
}

function projectPreview(record) {
  const updated = record.updatedAt ? new Date(record.updatedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "未记录";
  const count = Array.isArray(record.shots) ? record.shots.length : 0;
  return `<article>
    <span class="tag">${esc(record.project?.type || "项目")}</span>
    <h4>${esc(record.project?.name || "未命名项目")}</h4>
    <p>${esc(record.project?.duration || 0)}秒 · ${esc(record.project?.aspect || "未填画幅")} · ${esc(record.project?.platform || "未填平台")} · ${count} 个镜头<br />更新时间：${esc(updated)}</p>
    <button class="text-btn" data-open-project="${esc(record.id)}">继续编辑</button>
    <button class="text-btn" data-delete-project="${esc(record.id)}">删除</button>
  </article>`;
}

function renderDashboard() {
  const saved = loadSavedProjects();
  els.projectList.innerHTML = `
    <article>
      <span class="tag">示例项目</span>
      <h4>30秒新能源电动车广告</h4>
      <p>用于演示从脚本导入、剧本分析、分镜确认到生成分镜图的最终流程。</p>
      <button class="text-btn" id="openSample">打开示例</button>
    </article>
    <article>
      <span class="tag">新项目</span>
      <h4>从空白项目开始</h4>
      <p>先填写项目类型、时长、画幅、风格和目标平台，再导入脚本。</p>
      <button class="text-btn" id="openNew">选择新建</button>
    </article>
    ${saved.map(projectPreview).join("")}
  `;
}

function restoreProject(record) {
  if (!record) return;
  state.hydrating = true;
  state.projectId = record.id || newProjectId();
  state.project = { ...state.project, ...(record.project || {}) };
  state.detected = normalizeAnalysisData(record.detected || {});
  state.includeDialogue = true;
  state.includeNarration = true;
  state.shots = (Array.isArray(record.shots) ? record.shots : []).map((shot, index) => ({
    ...shot,
    id: shot.id || `${Date.now()}-${index}`,
    no: String(shot.no || index + 1).padStart(2, "0"),
    angle: textValue(shot.angle, "正面平视"),
    blocking: textValue(shot.blocking, hasPeopleInShot(shot) ? "人物停留在画面中央，面向主要主体。" : "无人物调度"),
    transition: textValue(shot.transition, index === 0 ? "开场建立" : "直切承接"),
    status: shot.status || "待确认",
  }));
  state.boardsGenerated = Boolean(record.boardsGenerated);
  applyProject(state.project);
  els.scriptInput.value = record.script || "";
  els.globalNotes.value = record.globalNotes || "";
  els.shotTarget.value = record.shotTarget || "";
  els.boardStyle.value = record.boardStyle || "";
  els.tone.value = tagText(record.overallColorTone || record.tone || DEFAULT_TONE, 3) || DEFAULT_TONE;
  els.visualStyle.value = tagText(record.overallVisualStyle || record.visualStyle || state.project.style || DEFAULT_VISUAL_STYLE, 3) || DEFAULT_VISUAL_STYLE;
  els.creativity.value = normalizeCreativityValue(record.creativity ?? 60, record.creativityScale || 4);
  updateCreativityUi();
  syncAllChoiceButtons();
  renderLookTagEditors();
	  renderAnalysis();
  renderShots();
  renderBoards();
  renderSummary();
  setScreen("workbench");
  state.hydrating = false;
  hydrateMissingReferenceMeta();
}

function resetWorkspace() {
	  state.hydrating = true;
	  state.projectId = "";
	  state.project = { ...DEFAULT_PROJECT };
  state.detected = emptyDetected();
  state.includeDialogue = true;
  state.includeNarration = true;
  state.shots = [];
  state.boardsGenerated = false;
  applyProject(state.project);
  els.scriptInput.value = "";
  els.globalNotes.value = "";
	  els.shotTarget.value = "";
	  els.boardStyle.value = "";
	  els.tone.value = DEFAULT_TONE;
	  els.visualStyle.value = DEFAULT_VISUAL_STYLE;
	  els.creativity.value = "60";
	  updateCreativityUi();
	  syncAllChoiceButtons();
	  renderLookTagEditors();
	  renderAnalysis();
  renderShots();
  renderBoards();
  renderSummary();
  state.hydrating = false;
}

function startNewProjectSetup() {
  resetWorkspace();
  setScreen("setup");
}

function setScreen(screen) {
  const nextScreen = screen !== "login" && !state.currentUser ? "login" : screen;
  state.screen = nextScreen;
  const isLogin = nextScreen === "login";
  els.loginPage.classList.toggle("hidden", !isLogin);
  els.platformShell.classList.toggle("hidden", isLogin);
  els.dashboard.classList.toggle("hidden", isLogin || nextScreen !== "dashboard");
  els.setup.classList.toggle("hidden", isLogin || nextScreen !== "setup");
  els.workbench.classList.toggle("hidden", isLogin || nextScreen !== "workbench");
  if (nextScreen === "dashboard") renderDashboard();
  document.querySelectorAll(".stage span").forEach((node, i) => {
    node.classList.toggle("active", (nextScreen === "dashboard" && i === 0) || (nextScreen === "workbench" && i > 0));
  });
}

function syncProjectFromForm() {
	  state.project = {
	    name: els.projectName.value || "未命名项目",
	    type: els.projectType.value || "未填写",
	    duration: readProjectDuration(),
	    aspect: els.aspect.value || "未填写",
	    style: tagText(els.style.value) || "未填写",
	    platform: els.platform.value || "未填写",
	  };
	  syncDurationInputs(state.project.duration);
	  if (!els.visualStyle.value.trim() && els.style.value) els.visualStyle.value = tagText(els.style.value, 3);
	  syncAllChoiceButtons();
	  renderLookTagEditors();
	  renderSummary();
	}

function applyProject(project) {
  els.projectName.value = project.name || "";
  els.projectType.value = project.type || "";
  syncDurationInputs(project.duration || 30);
	  els.aspect.value = project.aspect || "";
	  els.style.value = project.style || "";
	  els.platform.value = project.platform || "";
	  syncProjectFromForm();
	  syncAllChoiceButtons();
	  renderLookTagEditors();
	}

function detectTerms(script) {
  const has = (word) => script.includes(word);
  const people = unique(["年轻上班族", "主人公", "主角", "女主", "男主", "母亲", "父亲", "用户", "顾客", "年轻女性", "年轻男性", "女性用户", "男性用户", "女生", "男生", "女士", "男士", "学生", "妈妈", "孩子", "老人", "员工", "同事", "朋友", "家人", "店员", "客户", "讲述者"].filter(has));
  const product = unique(["新能源电动车", "健康饮食APP", "电动车", "车辆", "汽车", "手机", "APP", "小程序", "咖啡", "饮料", "护肤品", "课程", "产品", "服务"].filter(has));
  const locations = unique(["办公楼前", "城市街道", "通勤路口", "城市道路", "路口", "办公室", "会议室", "书房", "河边公园", "河边", "公园", "家中", "客厅", "厨房", "门店", "商场", "校园", "地铁站", "室内", "户外"].filter(has));
  const props = unique(["智能仪表", "车把", "启动键", "车轮", "头盔", "背包", "电量", "速度", "品牌口号", "手机", "电脑", "笔记本电脑", "水杯", "杯子", "书桌", "书本", "海报", "包装", "屏幕", "早餐", "食物", "界面"].filter(has));
  const times = unique(["清晨", "上午", "中午", "下午", "傍晚", "夜晚", "白天", "深夜"].filter(has));
  const sellingPoints = unique(["轻便", "安全", "智能", "平稳", "安静", "清晰", "高效", "便捷", "舒适", "可靠", "省时", "专业", "年轻", "高级"].filter(has));
  const dialogue = [...script.matchAll(/[“"『「]([^”"』」]{2,80})[”"』」]/g)].map((m) => m[1]);
  const narration = [...script.matchAll(/(?:旁白|口播|VO|字幕|文案)[：:]([^。！？!?；;\n]+)/gi)].map((m) => m[1].trim());
  const result = { people, product, locations, props, times, sellingPoints, dialogue, narration };
  return result;
}

function renderSummary() {
  const p = state.project;
  els.summary.innerHTML = [
    ["项目", p.name], ["类型", p.type], ["时长", `${p.duration}s`], ["画幅", p.aspect], ["风格", p.style], ["平台", p.platform],
  ].map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v || "未填写")}</dd>`).join("");
  const confirmed = state.shots.filter((s) => s.status === "已确认").length;
  els.shotCount.textContent = state.shots.length;
  els.confirmedCount.textContent = confirmed;
  els.boardCount.textContent = state.boardsGenerated ? confirmed : 0;
  els.notice.textContent = state.shots.length ? "分镜可继续编辑，确认后生成分镜图。" : "先导入脚本，再做剧本分析。";
}

function analysisCard(field, title, desc) {
  const value = (state.detected[field] || []).join("\n");
  const help = desc ? `<p>${desc}</p>` : "";
  return `<article class="analysis-card">
    <label><span>${title}</span><textarea data-analysis="${field}">${esc(value)}</textarea></label>
    ${help}
  </article>`;
}

function renderAnalysis() {
  els.analysisGrid.innerHTML = [
    analysisCard("people", "人物", "提取脚本中的主要角色、配角及群体人物。"),
    analysisCard("locations", "场景", "提取故事发生的具体空间、地点及环境场景。"),
    analysisCard("props", "道具", "提取镜头中涉及的关键物件、设备及视觉元素。"),
    analysisCard("product", "产品", "识别项目中需要重点呈现的产品、服务及核心对象。"),
    analysisCard("times", "时间段", "提取脚本中明确出现的时间阶段及昼夜信息。"),
    analysisCard("sellingPoints", "卖点", "提炼脚本重点传达的产品优势、功能价值及品牌信息。"),
    analysisCard("dialogue", "台词", "提取人物明确说出的对白，会自动带入分镜。"),
    analysisCard("narration", "旁白", "提取明确标注的旁白、口播及 VO 文案，会自动带入分镜。"),
  ].join("");
}

function storyboardBank() {
  return [
    ["地点建立", "办公楼前建立镜头，年轻上班族推着新能源电动车进入画面，先交代地点、人物和产品关系。", "远景", "缓慢推近", "道路线、环境", "地点、人物、产品关系"],
    ["启动细节", "手部特写触发车辆启动，智能仪表亮起，表现启动平稳和操作轻便。", "特写", "变焦推近", "车把、启动键、智能仪表", "启动细节与智能感"],
    ["创意机位", "低机位贴近车轮跟拍，车辆从城市街道轻快经过，地面线条快速后退。", "近景", "侧向跟拍", "车轮、道路线", "轻便、速度与稳定"],
    ["驾驶体验", "人物骑行经过路口，背景自然后移，画面重点放在安静、顺滑和真实通勤状态。", "全景", "横移跟拍", "头盔、背包", "通勤体验"],
    ["信息特写", "智能仪表清晰显示速度和电量，画面干净，不堆砌信息。", "特写", "缓慢推近", "智能仪表、电量、速度", "智能卖点"],
    ["安全瞬间", "人物在关键位置完成观察、停顿或确认动作，让安全感通过动作表达。", "中景", "固定镜头", "车灯、道路线", "安全感"],
    ["轻松收尾", "人物到达办公楼前轻松停车，车辆停在画面前景，人物状态轻松。", "中景", "半环绕", "停车点、背包", "轻松收尾"],
    ["口号留白", "广告收束，人物与车辆形成最后记忆点，画面侧边预留口号或字幕位置。", "全景", "缓慢拉远", "品牌口号占位", "品牌记忆"],
  ];
}

function scriptUnits(text, maxUnits = 8) {
  const source = String(text || "").replace(/\s+/g, " ").trim();
  if (!source) return [];
  const units = [];
  source.split(/[。！？!?；;\n]+/).forEach((part) => {
    const clean = part.trim().replace(/^[，,\s]+|[，,\s]+$/g, "");
    if (!clean) return;
    const clauses = clean.length > 42 ? clean.split(/[，,]/) : [clean];
    clauses.forEach((clause) => {
      const item = clause.trim();
      if (!item) return;
      const previous = units[units.length - 1];
      if (previous && previous.length + item.length < 28) units[units.length - 1] = `${previous}，${item}`;
      else units.push(item);
    });
  });
  return units.slice(0, maxUnits);
}

function pickFromText(options, text, fallback, offset = 0) {
  const values = unique(options || []);
  if (!values.length) return fallback;
  return values.find((item) => text.includes(item)) || values[offset % values.length];
}

function inferPropText(text, fallback = "环境元素") {
  if (/树|草|河|湖|路/.test(text)) return "树木、路面、环境";
  if (/电脑|屏幕|办公/.test(text)) return "电脑、书桌";
  if (/杯|水|咖啡|饮料/.test(text)) return "杯子";
  if (/书|资料|文件/.test(text)) return "书本、资料";
  if (/手机|APP|界面/.test(text)) return "手机、界面";
  return fallback;
}

function inferShotSize(text, index, total) {
  if (/眼神|表情/.test(text)) return "近景";
  if (/手|按钮|仪表|屏幕|局部|细节|特写/.test(text)) return "特写";
  if (/多人|两人|关系|互动|交流|走|跑|穿过|移动|进入|离开|产品|操作/.test(text)) return "中全景";
  if (index === 0) return "远景";
  if (index === total - 1) return "中景";
  return ["中景", "中全景", "全景", "中近景"][index % 4];
}

function inferCamera(text, index) {
  if (/走|跑|穿过|移动|经过|骑|跟/.test(text)) return "侧向跟拍";
  if (/看|相视|对视|发现|望|笑/.test(text)) return "缓慢推近";
  if (/放下|拿起|递|打开|启动/.test(text)) return "变焦推近";
  return ["固定镜头", "缓慢推近", "左横移", "半环绕"][index % 4];
}

function inferAngle(text, index) {
  if (/肩|背影|身后|跟随/.test(text)) return "过肩视角";
  if (/桌面|俯拍|摆放|书桌|电脑|手机|产品|餐|杯|布局|站位/.test(text)) return "高机位俯拍";
  if (/高楼|大楼|天空|仰望|宏大/.test(text)) return "低机位仰拍";
  if (/手|眼神|表情|细节|特写/.test(text)) return "正面平视";
  if (index === 0) return "正面平视";
  return ["正面平视", "侧面平视", "三分之二侧前方平视", "过肩视角"][index % 4];
}

function inferTransition(current, index, units = []) {
  if (index === 0) return "开场建立";
  const previous = units[index - 1] || "";
  if (/看|望|对视|眼神|发现/.test(previous + current)) return "视线匹配转场";
  if (/走|跑|穿过|进入|离开|推门|转身|移动/.test(previous + current)) return "动作接动作";
  if (/手|拿起|放下|打开|按下|递|触碰/.test(previous + current)) return "动作细节匹配";
  if (/声音|呼喊|旁白|音乐|电话|铃声|台词|说/.test(previous + current)) return "声音先行转场";
  if (/黑|暗|门|墙|背影|遮挡|经过/.test(previous + current)) return "遮挡转场";
  if (/相似|同样|重复|呼应|圆|线条|光/.test(previous + current)) return "相似构图匹配";
  return ["直切承接", "节奏硬切", "同方向运动衔接", "画面重点匹配"][index % 4];
}

function hasPeopleInShot(shot) {
  return !isPlaceholderValue(shot?.people);
}

function inferBlocking(text, index, peopleText = "") {
  if (isPlaceholderValue(peopleText)) return "无人物调度";
  if (/走|跑|穿过|漫步|移动|经过|进入/.test(text)) {
    return index % 2
      ? "人物从右侧入画，向画面中央移动，身体朝向前进方向，与场景形成纵深关系。"
      : "人物从左侧入画，横穿画面后停留在画面中央，面向主要主体。";
  }
  if (/靠近|走向|来到|接近/.test(text)) return "人物从后景向前景移动，最终停留在前景偏中位置，面向主要主体。";
  if (/离开|走出|远去/.test(text)) return "人物从画面中央向纵深移动并逐渐离开，背向镜头。";
  if (/相视|对视|聊天|说|交流/.test(text)) return "多人左右分布或前后错位站位，身体略微转向彼此，形成对话关系。";
  if (/电脑|桌|手机|产品|杯|道具/.test(text)) return "人物停留在主体道具一侧，身体朝向产品或道具，人物与产品形成前后层次。";
  return "人物停留在画面中央或三分线位置，身体朝向主要主体，保持清晰的人物与场景关系。";
}

function localShotType(text, index, total) {
  if (index === 0) return "场景建立";
  if (index === total - 1) return "情绪收束";
  if (/电脑|手机|杯|道具|手|细节/.test(text)) return "细节强调";
  if (/看|笑|相视|对话|说/.test(text)) return "关系反应";
  return "动作推进";
}

function localStoryboardShots() {
  const duration = readProjectDuration();
  const targetCount = requestedShotCount();
  let units = scriptUnits(els.scriptInput.value, targetCount || suggestShotCount());
  if (!units.length) {
    units = [
      `在${first(state.detected.locations, "主要场景")}建立人物和空间关系`,
      `围绕${first(state.detected.props, first(state.detected.product, "核心物件"))}呈现关键动作`,
      "捕捉人物反应和情绪变化",
      "用留白或稳定构图完成收束",
    ];
  }
  const total = targetCount || suggestShotCount();
  while (units.length < total) units.push(units[units.length - 1]);
  units = units.slice(0, total);
  const base = Math.floor(duration / units.length);
  let remain = duration - base * units.length;
  let currentLocation = first(state.detected.locations, "");
  const brief = els.globalNotes.value.trim();
  return units.map((unit, i) => {
    const people = pickFromText(state.detected.people, unit, "待补充人物", i);
    return {
      id: `${Date.now()}-${i}`,
      no: String(i + 1).padStart(2, "0"),
      type: localShotType(unit, i, units.length),
      content: unit,
      shotSize: inferShotSize(unit, i, units.length),
      angle: inferAngle(unit, i),
      camera: inferCamera(unit, i),
      blocking: inferBlocking(unit, i, people),
      transition: inferTransition(unit, i, units),
      duration: `${base + (remain-- > 0 ? 1 : 0)}s`,
      people,
      location: (currentLocation = state.detected.locations.find((item) => unit.includes(item)) || currentLocation || "待补充地点"),
      props: state.detected.props.find((item) => unit.includes(item)) || inferPropText(unit),
      product: pickFromText(state.detected.product, unit, "待补充产品", i),
      time: pickFromText(state.detected.times, unit, "待补充时间段", i),
      dialogue: pickFromText(state.detected.dialogue, unit, "无台词", i),
      narration: pickFromText(state.detected.narration, unit, "无旁白", i),
      focus: pickFromText(state.detected.sellingPoints, unit, brief ? `结合创作要求：${brief}` : "画面关系与情绪变化", i),
      status: "待确认",
      refName: "",
      refData: "",
      refMeta: null,
    };
  });
}

function textValue(value, fallback = "") {
  if (Array.isArray(value)) return value.filter(Boolean).join("、") || fallback;
  return String(value ?? "").trim() || fallback;
}

function isPlaceholderValue(value) {
  const text = String(value || "").trim();
  return !text || /^待补充|^无台词$|^无旁白$|^未识别$|^未上传$/.test(text);
}

function cleanField(value) {
  return isPlaceholderValue(value) ? "" : String(value || "").trim();
}

function regenerateShotFromFields(shot) {
  const time = cleanField(shot.time);
  const location = cleanField(shot.location);
  const people = cleanField(shot.people);
  const product = cleanField(shot.product);
  const props = cleanField(shot.props);
  const focus = cleanField(shot.focus);
  const blocking = cleanField(shot.blocking);
  const subject = [people, product].filter(Boolean).join("与") || people || product || "主要主体";
  const propText = props ? `，画面中包含${props}` : "";
  const blockingText = blocking ? `，人物调度为${blocking}` : "";
  const spaceText = [time, location].filter(Boolean).join("，") || "当前场景";
  const focusText = focus ? `，画面重点是${focus}` : "，保留原镜头的动作与叙事节奏";
  shot.content = `${spaceText}中，镜头围绕${subject}展开${propText}${blockingText}${focusText}。`;
  shot.boardImage = "";
  shot.boardWarning = "";
  shot.boardSource = "";
  shot.boardModel = "";
  shot.status = "待确认";
  state.boardsGenerated = false;
}

function normalizeShot(shot, index) {
  return {
    id: `${Date.now()}-${index}`,
    no: String(shot.no || index + 1).padStart(2, "0"),
    type: textValue(shot.type, "镜头"),
    content: textValue(shot.content, "请补充画面内容。"),
    shotSize: textValue(shot.shotSize, "中景"),
    angle: textValue(shot.angle, "正面平视"),
    camera: textValue(shot.camera, "固定镜头"),
    blocking: textValue(shot.blocking, hasPeopleInShot(shot) ? "人物停留在画面中央，面向主要主体。" : "无人物调度"),
    transition: textValue(shot.transition, index === 0 ? "开场建立" : "直切承接"),
    duration: textValue(shot.duration, "3s"),
    people: textValue(shot.people, "待补充人物"),
    location: textValue(shot.location, "待补充地点"),
    props: textValue(shot.props, "待补充道具"),
    product: textValue(shot.product, "待补充产品"),
    time: textValue(shot.time, "待补充时间段"),
    dialogue: textValue(shot.dialogue, "无台词"),
    narration: textValue(shot.narration, "无旁白"),
    focus: textValue(shot.focus, "待补充"),
    status: "待确认",
    refName: shot.refName || "",
    refData: shot.refData || "",
    refMeta: shot.refMeta || null,
  };
}

function splitPayload() {
  const overallColorTone = tagText(els.tone.value, 3);
  const overallVisualStyle = tagText(els.visualStyle.value, 3);
  return {
    script: els.scriptInput.value.trim(),
    project: state.project,
    analysis: state.detected,
    includeDialogue: true,
    includeNarration: true,
    boardStyle: els.boardStyle.value,
    tone: overallColorTone,
    visualStyle: overallVisualStyle,
    overallColorTone,
    overallVisualStyle,
    creativity: els.creativity.value,
    creativityLabel: creativityLabel(),
    shotCount: els.shotTarget.value.trim(),
    globalNotes: els.globalNotes.value.trim(),
  };
}

function analysisPayload() {
	  return {
	    script: els.scriptInput.value.trim(),
	    project: state.project,
	    creativity: els.creativity.value,
    shotCount: els.shotTarget.value.trim(),
    globalNotes: els.globalNotes.value.trim(),
  };
}

function normalizeAnalysisData(analysis = {}) {
  return {
    people: Array.isArray(analysis.people) ? unique(analysis.people) : parseList(analysis.people),
    product: Array.isArray(analysis.product) ? unique(analysis.product) : parseList(analysis.product),
    locations: Array.isArray(analysis.locations) ? unique(analysis.locations) : parseList(analysis.locations),
    props: Array.isArray(analysis.props) ? unique(analysis.props) : parseList(analysis.props),
    times: Array.isArray(analysis.times) ? unique(analysis.times) : parseList(analysis.times),
    sellingPoints: Array.isArray(analysis.sellingPoints) ? unique(analysis.sellingPoints) : parseList(analysis.sellingPoints),
    dialogue: Array.isArray(analysis.dialogue) ? unique(analysis.dialogue) : parseList(analysis.dialogue),
    narration: Array.isArray(analysis.narration) ? unique(analysis.narration) : parseList(analysis.narration),
  };
}

async function requestScriptAnalysis() {
  if (!canUseBackend()) throw new Error("当前是 file 打开方式，无法连接后端接口。");
  const response = await fetch("/api/script/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(analysisPayload()),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "剧本分析接口请求失败。");
    error.status = response.status;
    throw error;
  }
  if (!data.analysis || typeof data.analysis !== "object") throw new Error("剧本分析接口未返回分析结果。");
  return data;
}

async function requestStoryboardSplit() {
  if (!canUseBackend()) throw new Error("当前是 file 打开方式，无法连接后端接口。");
  const response = await fetch("/api/storyboard/split", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(splitPayload()),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "拆分镜接口请求失败。");
    error.status = response.status;
    throw error;
  }
  if (!Array.isArray(data.shots) || !data.shots.length) throw new Error("拆分镜接口未返回镜头数据。");
  return data;
}

async function requestScriptImport(file) {
  if (!canUseBackend()) throw new Error("当前是 file 打开方式，无法连接后端接口。");
  const form = new FormData();
  form.append("file", file);
  const response = await fetch("/api/script/import", { method: "POST", body: form });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "文件读取失败。");
    error.status = response.status;
    throw error;
  }
  return data;
}

function generatedTagValue(data, keys, max = 3) {
  for (const key of keys) {
    const value = data?.[key];
    const text = Array.isArray(value) ? value.join("、") : String(value || "");
    const normalized = tagText(text, max);
    if (normalized) return normalized;
  }
  return "";
}

function applyGeneratedLook(data) {
  const generatedTone = generatedTagValue(data, ["overallColorTone", "overallTone", "tone", "colorTone", "整体色调"], 3);
  const generatedStyle = generatedTagValue(data, ["overallVisualStyle", "visualStyle", "style", "整体视觉风格", "整体风格"], 3);
  if (generatedTone) setLookValues("tone", parseTagList(generatedTone, 3));
  if (generatedStyle) setLookValues("visualStyle", parseTagList(generatedStyle, 3));
  syncChoiceButtons("tone");
  syncChoiceButtons("visualStyle");
  renderLookTagEditors();
}

async function splitStoryboard() {
  syncProjectFromForm();
  syncAnalysisFromInputs();
  const script = els.scriptInput.value.trim();
  if (!script) return showToast("请先输入或上传脚本。");
  const splitButton = $("#split");
  const buttonText = splitButton.textContent;
  splitButton.disabled = true;
  splitButton.textContent = "正在拆解...";

  try {
    const data = await requestStoryboardSplit();
    applyGeneratedLook(data);
    state.shots = data.shots.map(normalizeShot);
    if (data.warning) showToast(data.warning);
    else showToast(data.source === "ai" ? "AI 已完成分镜拆解，请逐条确认。" : "已使用后端演示模式拆解分镜。");
  } catch (error) {
    console.warn(error);
    if (isAuthError(error)) {
      state.currentUser = null;
      resetWorkspace();
      updateAuthUi();
      setScreen("login");
      showToast("登录已过期，请重新登录。");
      splitButton.disabled = false;
      splitButton.textContent = buttonText;
      return;
    }
    state.shots = localStoryboardShots();
    showToast("后端未连接，已使用前端本地演示拆解。");
  }
  state.boardsGenerated = false;
  renderShots();
  renderBoards();
  renderSummary();
  saveCurrentProject();
  splitButton.disabled = false;
  splitButton.textContent = buttonText;
}

function fillApiForm(config) {
  els.apiProvider.value = config.provider || "mock";
  els.apiBaseUrl.value = config.apiBaseUrl || "";
  els.apiTextModel.value = config.textModel || "";
  els.apiImageModel.value = config.imageModel || "";
  els.apiTemperature.value = config.temperature || "0.7";
  els.apiKey.value = "";
  els.apiKey.placeholder = config.apiKeyConfigured ? config.apiKeyHint : "sk-...";
  const warning = Array.isArray(config.warnings) && config.warnings.length ? ` ${config.warnings.join(" ")}` : "";
  els.apiStatus.textContent = config.textConfigured
    ? `拆分镜模型已配置：${config.textModel}`
    : "当前未配置真实拆分镜模型，会使用本地演示模式。";
  els.apiStatus.textContent += warning;
}

async function loadApiConfig() {
  if (!canUseBackend()) {
    els.apiStatus.textContent = "当前是直接打开 HTML，无法读取后端配置。请使用“打开本地网页.command”。";
    return;
  }
  try {
    const response = await fetch("/api/config");
    const config = await response.json();
    if (!response.ok) throw new Error(config.error || "读取配置失败");
    fillApiForm(config);
  } catch (error) {
    console.warn(error);
    els.apiStatus.textContent = "无法连接本地后端，请确认启动入口没有被关闭。";
  }
}

async function saveApiConfig() {
  if (!canUseBackend()) return showToast("请使用打开本地网页.command 后再保存 API 配置。");
  if (!state.currentUser) return showToast("请先登录，再配置自己的 API。");
  const button = $("#apiSave");
  const buttonText = button.textContent;
  button.disabled = true;
  button.textContent = "保存中...";
  try {
    const response = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: els.apiProvider.value,
        apiBaseUrl: els.apiBaseUrl.value,
        apiKey: els.apiKey.value,
        textModel: els.apiTextModel.value,
        imageModel: els.apiImageModel.value,
        temperature: els.apiTemperature.value,
      }),
    });
    const config = await response.json();
    if (!response.ok) throw new Error(config.error || "保存配置失败");
    fillApiForm(config);
    showToast("API 配置已保存到本地后端。");
    els.apiDialog.close();
  } catch (error) {
    console.warn(error);
    els.apiStatus.textContent = error.message || "保存配置失败。";
    showToast("API 配置保存失败。");
  } finally {
    button.disabled = false;
    button.textContent = buttonText;
  }
}

function updateAuthUi(config) {
  const label = state.currentUser ? (state.currentUser.name || state.currentUser.email) : "登录";
  els.authBtn.textContent = label.length > 10 ? `${label.slice(0, 10)}...` : label;
  els.authStatus.textContent = state.currentUser
    ? `已登录：${state.currentUser.email}。正在进入你的项目看板。`
    : "请先登录。登录后进入项目看板，再进入工作台。";
  if (config) fillApiForm(config);
}

async function loadSession() {
  if (!canUseBackend()) {
    updateAuthUi();
    els.authStatus.textContent = "请使用“打开本地网页.command”启动后再登录。";
    setScreen("login");
    return;
  }
  try {
    const response = await fetch("/api/auth/me");
    const data = await response.json();
    state.currentUser = data.user || null;
    updateAuthUi(data.config);
    if (state.currentUser) {
      await loadRemoteProjects();
      setScreen("dashboard");
    } else {
      setScreen("login");
    }
  } catch (error) {
    console.warn(error);
    state.currentUser = null;
    updateAuthUi();
    setScreen("login");
  }
}

async function submitAuth(mode) {
  if (!canUseBackend()) return showToast("请使用打开本地网页.command 后再登录。");
  const identifier = els.authName.value.trim() || els.authEmail.value.trim();
  const payload = {
    name: els.authName.value.trim(),
    email: els.authEmail.value.trim(),
    identifier,
    password: els.authPassword.value,
  };
  const button = mode === "login" ? els.loginBtn : els.registerBtn;
  const buttonText = button.textContent;
  button.disabled = true;
  button.textContent = mode === "login" ? "登录中..." : "注册中...";
  try {
    const response = await fetch(`/api/auth/${mode}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "账号操作失败");
    els.authPassword.value = "";
    if (mode === "register") {
      state.currentUser = null;
      updateAuthUi(data.config);
      els.authStatus.textContent = data.message || "注册成功，请使用用户名或邮箱登录。";
      showToast("注册成功，请登录。");
      return;
    }
    state.currentUser = data.user;
    updateAuthUi(data.config);
    await loadRemoteProjects();
    setScreen("dashboard");
    if (hasProjectContent()) saveCurrentProject();
    showToast("登录成功。");
  } catch (error) {
    console.warn(error);
    els.authStatus.textContent = error.message || "账号操作失败。";
  } finally {
    button.disabled = false;
    button.textContent = buttonText;
  }
}

async function logout() {
  if (!canUseBackend()) return;
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } catch (error) {
    console.warn(error);
  }
  state.currentUser = null;
  resetWorkspace();
  els.authName.value = "";
  els.authEmail.value = "";
  els.authPassword.value = "";
  updateAuthUi();
  setScreen("login");
  showToast("已退出登录。");
}

function input(field, value, label) {
  return `<label><span>${label}</span><input data-field="${field}" value="${esc(value)}" /></label>`;
}

function longInput(field, value, label) {
  return `<label><span>${label}</span><input data-field="${field}" value="${esc(value)}" /></label>`;
}

function multi(field, value, label, options) {
  const chosen = parseList(value);
  return `<label class="multi-field"><span>${label}</span><input data-field="${field}" value="${esc(value)}" placeholder="可选择，也可手动输入" />
    <div class="chips">${options.map((o) => `<button class="chip ${chosen.includes(o) ? "active" : ""}" type="button" data-chip="${field}" data-value="${esc(o)}">${esc(o)}</button>`).join("") || "<span class='chip'>暂无识别项</span>"}</div>
  </label>`;
}

function referenceRow(shot, index) {
  const preview = shot.refData ? `<img class="reference-thumb" src="${shot.refData}" alt="${esc(shot.refName)}" />` : `<div class="reference-empty">未上传</div>`;
  const removeButton = shot.refData ? `<button class="mini danger-mini" type="button" data-action="remove-ref">删除参考图</button>` : "";
  return `<div class="reference-row">
    ${preview}
    <div class="reference-meta"><strong>分镜参考图</strong><span>${shot.refName ? `已上传：${esc(shot.refName)}` : "可选上传线稿、截图或参考图，辅助生成这一镜头的分镜图。"}</span></div>
    <div class="reference-actions"><input class="reference-input" id="ref-${index}" type="file" accept="image/*" data-ref="${index}" /><label class="mini" for="ref-${index}">${shot.refData ? "替换图片" : "上传图片"}</label>${removeButton}</div>
  </div>`;
}

function renderShots() {
  if (!state.shots.length) {
    els.shots.innerHTML = `<div class="empty">确认剧本分析后，这里会出现分镜卡片。</div>`;
    return;
  }
  els.shots.innerHTML = state.shots.map((shot, i) => {
    const cls = shot.status === "已确认" ? "ok" : shot.status === "需修改" ? "revise" : "";
    return `<article class="shot-card" data-index="${i}">
      <div class="shot-no">${shot.no}</div>
      <div class="shot-main">
        <textarea data-field="content">${esc(shot.content)}</textarea>
        <div class="shot-layout">
          <div class="shot-meta-row">${input("shotSize", shot.shotSize, "景别")}${input("duration", shot.duration, "时长")}${input("angle", shot.angle, "角度")}${input("camera", shot.camera, "运镜")}</div>
          <div class="blocking-row">${longInput("blocking", shot.blocking, "人物调度")}</div>
          <div class="transition-row">${longInput("transition", shot.transition, "转场/衔接")}</div>
          <div class="shot-entity-row">
            ${multi("people", shot.people, "人物", state.detected.people)}
            ${multi("location", shot.location, "场景", state.detected.locations)}
            ${multi("props", shot.props, "道具", state.detected.props)}
            ${multi("product", shot.product, "产品", state.detected.product)}
            ${multi("time", shot.time, "时间段", state.detected.times)}
          </div>
          <div class="long-row">${longInput("dialogue", shot.dialogue, "台词")}${longInput("narration", shot.narration, "旁白")}</div>
          ${referenceRow(shot, i)}
        </div>
      </div>
      <div class="shot-side">
        <span class="status-pill ${cls}">${shot.status}</span>
        <button class="mini" data-action="regen-shot">按字段更新描述</button>
        <button class="mini" data-action="confirm">确认此镜头</button>
        <button class="mini" data-action="unconfirm">取消确认</button>
        <button class="mini" data-action="revise">标记修改</button>
        <button class="mini" data-action="delete">删除</button>
      </div>
    </article>`;
  }).join("");
}

function compact(value, max = 18) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function textBlob(shot) {
  return [shot.content, shot.shotSize, shot.angle, shot.camera, shot.blocking, shot.transition, shot.people, shot.location, shot.props, shot.product, shot.time, shot.focus, shot.dialogue, shot.narration].join(" ");
}

function hasAny(text, words) {
  return words.some((word) => text.includes(word));
}

function hashText(text) {
  let hash = 0;
  String(text || "").split("").forEach((char) => {
    hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  });
  return Math.abs(hash);
}

function boardPalette(seed) {
  const style = els.boardStyle.value;
  const tone = style === "写实版" ? `${els.tone.value} ${els.visualStyle.value}` : "";
  const warm = hasAny(tone, ["暖", "阳光", "温柔", "清晨"]);
  const night = hasAny(tone, ["夜", "冷", "暗"]);
  const realistic = style === "写实版";
  const sketch = style === "线稿" || style === "火柴人";
  return {
    bg: night ? "#162033" : warm ? "#fff3dc" : "#edf6f4",
    sky: night ? "#1c2840" : warm ? "#ffe3ad" : "#d9ebff",
    ground: night ? "#263248" : warm ? "#e7d4ae" : "#d8e8df",
    line: "#172528",
    soft: realistic ? (warm ? "#f1be73" : "#83b7a7") : "#f8fbff",
    accent: ["#215cff", "#0f9f6e", "#d96c2c", "#7a5cff"][seed % 4],
    fill: realistic,
    sketch,
    stroke: style === "火柴人" ? 5 : 3,
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function shotComposition(shot, seed) {
  const meta = shot.refMeta && typeof shot.refMeta === "object" ? shot.refMeta : null;
  const defaultX = 0.34 + ((seed % 5) * 0.08);
  const defaultY = /特写|近景/.test(String(shot.shotSize || "")) ? 0.42 : 0.56;
  return {
    hasReference: Boolean(meta),
    subjectX: clamp(Number(meta?.subjectX ?? defaultX), 0.18, 0.82),
    subjectY: clamp(Number(meta?.subjectY ?? defaultY), 0.22, 0.74),
    balance: meta?.balance || "center",
    aspect: Number(meta?.aspect || 1.78),
    brightness: Number(meta?.brightness || 0.62),
    warmth: Number(meta?.warmth || 0.5),
  };
}

function compositionLabel(composition) {
  const horizontal = composition.subjectX < 0.4 ? "主体偏左" : composition.subjectX > 0.6 ? "主体偏右" : "主体居中";
  const vertical = composition.subjectY < 0.42 ? "上方留白" : composition.subjectY > 0.62 ? "低机位/下方主体" : "中部构图";
  return `${horizontal}，${vertical}`;
}

function compositionGuideSvg(composition, palette) {
  if (!composition.hasReference) return "";
  const x = 64 + composition.subjectX * 512;
  const y = 64 + composition.subjectY * 184;
  return `<g opacity=".58">
    <line x1="213" y1="0" x2="213" y2="360" stroke="${palette.accent}" stroke-width="1.5" stroke-dasharray="6 8"/>
    <line x1="426" y1="0" x2="426" y2="360" stroke="${palette.accent}" stroke-width="1.5" stroke-dasharray="6 8"/>
    <line x1="0" y1="120" x2="640" y2="120" stroke="${palette.accent}" stroke-width="1.5" stroke-dasharray="6 8"/>
    <circle cx="${x}" cy="${y}" r="34" fill="none" stroke="${palette.accent}" stroke-width="4"/>
    <text x="24" y="282" font-family="Microsoft YaHei" font-size="13" fill="${palette.accent}">参考图构图：${esc(compositionLabel(composition))} · 已重新绘制</text>
  </g>`;
}

function sceneBackgroundSvg(shot, palette, seed) {
  const text = textBlob(shot);
  const sun = hasAny(text, ["夜晚", "深夜", "夜"]) ? `<circle cx="560" cy="58" r="22" fill="#f4f0c9"/>` : `<circle cx="558" cy="58" r="24" fill="#ffd36f"/>`;
  if (hasAny(text, ["公园", "园林", "树", "草", "湖", "河", "户外"])) {
    const water = hasAny(text, ["河", "湖"]) ? `<path d="M0 260 C120 232 230 285 360 255 S555 228 640 258 L640 360 L0 360 Z" fill="#b8dceb" opacity=".8"/>` : "";
    return `<rect width="640" height="360" fill="${palette.sky}"/>${sun}
      <path d="M0 242 C130 210 240 230 350 250 S530 286 640 238 L640 360 L0 360 Z" fill="${palette.ground}"/>
      ${water}
      <path d="M58 245 C118 185 156 184 212 242" fill="none" stroke="${palette.line}" stroke-width="3" opacity=".35"/>
      ${[70, 150, 480, 555].map((x, i) => `<g transform="translate(${x},${120 + (i % 2) * 18})"><path d="M28 105 V28" stroke="${palette.line}" stroke-width="7"/><circle cx="28" cy="24" r="${28 + (seed + i) % 13}" fill="${palette.soft}" stroke="${palette.line}" stroke-width="3"/></g>`).join("")}
      <rect x="420" y="222" width="90" height="18" rx="4" fill="${palette.soft}" stroke="${palette.line}" stroke-width="3"/><path d="M438 240 V268 M492 240 V268" stroke="${palette.line}" stroke-width="3"/>`;
  }
  if (hasAny(text, ["书房", "书桌", "办公室", "办公", "电脑", "书", "室内"])) {
    return `<rect width="640" height="360" fill="#f3f5f8"/>
      <rect y="248" width="640" height="112" fill="#e2e6ea"/>
      <rect x="48" y="60" width="118" height="172" fill="${palette.soft}" stroke="${palette.line}" stroke-width="3"/>
      <rect x="474" y="54" width="112" height="94" fill="#d9ebff" stroke="${palette.line}" stroke-width="3"/>
      ${[84, 122, 520].map((x, i) => `<line x1="${x}" y1="${76 + i * 44}" x2="${x + 42}" y2="${76 + i * 44}" stroke="${palette.line}" stroke-width="5" opacity=".55"/>`).join("")}
      <rect x="150" y="224" width="340" height="34" rx="5" fill="#d8c4a1" stroke="${palette.line}" stroke-width="3"/>
      <path d="M184 258 V330 M456 258 V330" stroke="${palette.line}" stroke-width="5"/>`;
  }
  if (hasAny(text, ["街", "路", "城市", "楼", "广场", "门店", "商场"])) {
    return `<rect width="640" height="360" fill="${palette.sky}"/>${sun}
      <path d="M0 270 H640 V360 H0 Z" fill="#d9dce2"/>
      ${[48, 155, 462, 540].map((x, i) => `<rect x="${x}" y="${80 + (i % 2) * 34}" width="${72 + i * 7}" height="${170 - (i % 2) * 22}" fill="${palette.soft}" stroke="${palette.line}" stroke-width="3"/><path d="M${x + 18} ${112 + (i % 2) * 34} h36 M${x + 18} ${150 + (i % 2) * 34} h36 M${x + 18} ${188 + (i % 2) * 34} h36" stroke="${palette.line}" stroke-width="3" opacity=".38"/>`).join("")}
      <path d="M34 312 H606" stroke="${palette.line}" stroke-width="3" opacity=".3" stroke-dasharray="30 18"/>`;
  }
  return `<rect width="640" height="360" fill="${palette.bg}"/>${sun}
    <path d="M0 255 C128 228 230 238 340 263 S530 294 640 250 L640 360 L0 360 Z" fill="${palette.ground}"/>
    <rect x="70" y="92" width="118" height="140" rx="4" fill="${palette.soft}" stroke="${palette.line}" stroke-width="3"/>
    <rect x="452" y="100" width="96" height="132" rx="4" fill="${palette.soft}" stroke="${palette.line}" stroke-width="3"/>`;
}

function personSvg(x, y, scale, palette, variant = 0) {
  const bodyFill = palette.fill ? (variant % 2 ? "#f1b0a0" : "#8eb8e6") : "none";
  if (els.boardStyle.value === "火柴人") {
    return `<g transform="translate(${x},${y}) scale(${scale})" stroke="${palette.line}" stroke-width="${palette.stroke}" fill="none" stroke-linecap="round">
      <circle cx="26" cy="18" r="15"/><path d="M26 36 L24 88"/><path d="M24 58 L0 78"/><path d="M27 58 L58 76"/><path d="M24 88 L4 132"/><path d="M26 88 L56 132"/>
    </g>`;
  }
  return `<g transform="translate(${x},${y}) scale(${scale})" stroke="${palette.line}" stroke-width="3" stroke-linejoin="round">
    <circle cx="26" cy="18" r="15" fill="#f5d3bd"/>
    <path d="M8 54 Q26 32 45 54 L54 102 Q28 118 0 102 Z" fill="${bodyFill}"/>
    <path d="M9 60 L-8 86 M44 60 L66 82 M18 104 L8 139 M38 104 L52 139" fill="none" stroke-linecap="round"/>
  </g>`;
}

function propSvg(shot, palette, close = false, composition = null) {
  const text = textBlob(shot);
  const s = close ? 1.55 : 1;
  const subjectX = Number(composition?.subjectX ?? 0.48);
  const subjectY = Number(composition?.subjectY ?? 0.54);
  const propSide = subjectX < 0.52 ? 1 : -1;
  const baseX = close
    ? clamp(240 + subjectX * 110, 150, 360)
    : clamp(300 + propSide * 120 + (subjectX - 0.5) * 60, 120, 475);
  const y = close ? clamp(128 + subjectY * 80, 125, 205) : clamp(205 + subjectY * 36, 205, 245);
  if (hasAny(text, ["电脑", "屏幕", "笔记本"])) {
    return `<g transform="translate(${baseX},${close ? y - 24 : y}) scale(${s})" stroke="${palette.line}" stroke-width="3" fill="${palette.fill ? "#c9d7ef" : "none"}">
      <rect x="0" y="0" width="114" height="70" rx="5"/><path d="M20 82 H98 L112 104 H6 Z"/><line x1="20" y1="18" x2="92" y2="18"/><line x1="20" y1="38" x2="74" y2="38"/>
    </g>`;
  }
  if (hasAny(text, ["杯", "水", "咖啡", "饮料"])) {
    return `<g transform="translate(${baseX + 34},${close ? y : y + 2}) scale(${s})" stroke="${palette.line}" stroke-width="3" fill="${palette.fill ? "#f4f7fb" : "none"}">
      <path d="M0 8 H60 L52 82 H8 Z"/><path d="M60 22 C96 20 94 68 55 64" fill="none"/><path d="M12 24 H50"/>
    </g>`;
  }
  if (hasAny(text, ["书", "资料", "文件"])) {
    return `<g transform="translate(${baseX},${close ? y + 4 : y + 18}) scale(${s})" stroke="${palette.line}" stroke-width="3" fill="${palette.fill ? "#ffe7a5" : "none"}">
      <path d="M0 0 L82 12 V78 L0 64 Z"/><path d="M82 12 L118 0 V64 L82 78 Z"/><line x1="22" y1="24" x2="64" y2="30"/>
    </g>`;
  }
  if (hasAny(text, ["手机", "APP", "界面"])) {
    return `<g transform="translate(${baseX + 42},${close ? y - 38 : y - 8}) scale(${s})" stroke="${palette.line}" stroke-width="3" fill="${palette.fill ? "#e9f2ff" : "none"}">
      <rect x="0" y="0" width="58" height="102" rx="10"/><circle cx="29" cy="88" r="4"/><line x1="14" y1="24" x2="44" y2="24"/><line x1="14" y1="42" x2="44" y2="42"/>
    </g>`;
  }
  if (hasAny(text, ["车", "自行车", "电动车", "汽车"])) {
    return `<g transform="translate(${clamp(baseX - 70, 170, 360)},224)" stroke="${palette.line}" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round">
      <path d="M35 42 L98 18 L172 34 L220 58"/><circle cx="66" cy="76" r="27"/><circle cx="185" cy="76" r="27"/><path d="M132 28 L160 0 L202 8"/>
    </g>`;
  }
  return `<g transform="translate(${baseX},${close ? y : y}) scale(${s})" stroke="${palette.line}" stroke-width="3" fill="${palette.fill ? "#f3d58b" : "none"}">
    <rect x="0" y="0" width="88" height="70" rx="8"/><path d="M14 22 H72 M14 42 H54"/>
  </g>`;
}

function cameraGuideSvg(camera, palette, id) {
  const text = String(camera || "");
  if (hasAny(text, ["跟", "横", "移"])) return `<path d="M80 58 H190" stroke="${palette.accent}" stroke-width="5" marker-end="url(#arrow-${id})"/><text x="82" y="48" font-family="Microsoft YaHei" font-size="13" fill="${palette.accent}">跟随移动</text>`;
  if (hasAny(text, ["推", "推进"])) return `<path d="M560 62 C500 80 468 108 438 150" stroke="${palette.accent}" stroke-width="5" fill="none" marker-end="url(#arrow-${id})"/><text x="456" y="52" font-family="Microsoft YaHei" font-size="13" fill="${palette.accent}">镜头推进</text>`;
  if (hasAny(text, ["拉", "远"])) return `<path d="M430 86 C492 72 532 58 588 42" stroke="${palette.accent}" stroke-width="5" fill="none" marker-end="url(#arrow-${id})"/><text x="442" y="112" font-family="Microsoft YaHei" font-size="13" fill="${palette.accent}">缓慢拉远</text>`;
  if (hasAny(text, ["环", "绕", "摇"])) return `<path d="M472 72 C560 55 600 116 540 164 C486 208 402 174 424 112" stroke="${palette.accent}" stroke-width="5" fill="none" marker-end="url(#arrow-${id})"/><text x="454" y="54" font-family="Microsoft YaHei" font-size="13" fill="${palette.accent}">环绕/摇移</text>`;
  return `<rect x="475" y="38" width="112" height="58" rx="7" fill="none" stroke="${palette.accent}" stroke-width="3"/><text x="494" y="73" font-family="Microsoft YaHei" font-size="13" fill="${palette.accent}">固定构图</text>`;
}

function boardSvg(shot, index) {
  const blob = textBlob(shot);
  const seed = hashText(blob || `${shot.no}-${index}`);
  const palette = boardPalette(seed);
  const footer = els.boardStyle.value === "写实版"
    ? `${els.boardStyle.value} · ${compact(els.tone.value, 14)} · 按当前分镜内容生成的参考草图`
    : `${els.boardStyle.value} · 中性草图 · 按当前分镜内容生成的参考草图`;
  const composition = shotComposition(shot, seed);
  const close = /特写|近景/.test(String(shot.shotSize || "")) && hasAny(blob, ["手", "电脑", "杯", "手机", "书", "道具", "细节", "表情", "眼神"]);
  const peopleCount = Math.min(3, Math.max(1, parseList(shot.people).filter((item) => !item.includes("待补充")).length || (hasAny(blob, ["两人", "母亲", "女主", "男主", "相视"]) ? 2 : 1)));
  const personX = clamp(66 + composition.subjectX * 430, 70, 450);
  const personY = clamp(82 + composition.subjectY * 112, 108, 172);
  const people = close
    ? `<path d="M${personX - 68} ${personY + 116} C${personX - 20} ${personY + 64} ${personX + 50} ${personY + 72} ${personX + 108} ${personY + 118}" stroke="${palette.line}" stroke-width="13" fill="none" stroke-linecap="round" opacity=".7"/>`
    : Array.from({ length: peopleCount }, (_, i) => personSvg(personX + i * 62 - (peopleCount - 1) * 28, personY + (i % 2) * 14, /远景|全景/.test(String(shot.shotSize || "")) ? .62 : .82, palette, i)).join("");
  const focusBox = `<rect x="22" y="292" width="596" height="42" rx="8" fill="rgba(255,255,255,.72)" stroke="${palette.line}" stroke-width="2" opacity=".92"/>
    <text x="38" y="318" font-family="Microsoft YaHei" font-size="14" fill="${palette.line}">场景：${esc(compact(shot.location, 12))} · 人物：${esc(compact(shot.people, 12))} · 道具：${esc(compact(shot.props, 12))}</text>`;
  return `<svg viewBox="0 0 640 360" xmlns="http://www.w3.org/2000/svg">
    <defs><marker id="arrow-${index}" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="${palette.accent}"/></marker></defs>
    ${sceneBackgroundSvg(shot, palette, seed)}
    ${compositionGuideSvg(composition, palette)}
    ${people}
    ${propSvg(shot, palette, close, composition)}
    ${cameraGuideSvg(shot.camera, palette, index)}
    <rect x="18" y="18" width="284" height="42" rx="8" fill="rgba(255,255,255,.78)" stroke="${palette.line}" stroke-width="2"/>
    <text x="34" y="45" font-family="Microsoft YaHei" font-size="20" fill="${palette.line}" font-weight="800">${esc(shot.no)} ${esc(compact(shot.type, 10))}</text>
    <text x="318" y="45" font-family="Microsoft YaHei" font-size="15" fill="${palette.line}">${esc(compact(shot.shotSize, 6))} · ${esc(compact(shot.angle, 7))} · ${esc(compact(shot.camera, 8))}</text>
    ${focusBox}
    <text x="24" y="350" font-family="Microsoft YaHei" font-size="13" fill="${palette.line}" opacity=".72">${esc(footer)}</text>
  </svg>`;
}

function renderBoards() {
  const confirmed = state.shots.filter((shot) => shot.status === "已确认");
  if (!state.boardsGenerated || !confirmed.length) {
    els.boards.innerHTML = `<div class="empty">确认分镜后点击生成分镜图。</div>`;
    renderSummary();
    return;
  }
  els.boards.innerHTML = confirmed.map((shot, i) => {
    const hasAiImage = Boolean(shot.boardImage);
    const warning = shot.boardWarning || (!hasAiImage ? "图片未生成。请检查图片模型配置后重新点击“生成分镜图”。" : "");
    const sourceTag = hasAiImage ? "真实生图" : "未生成";
    return `
    <article class="board-card">
      <div class="frame ${hasAiImage ? "" : "frame-empty"}">
        ${hasAiImage ? `<img class="frame-image" src="${esc(shot.boardImage)}" alt="${esc(shot.no)} ${esc(shot.type)}" />` : `
          <div class="frame-empty-content">
            <strong>${esc(els.boardStyle.value || "分镜图")}未生成</strong>
            <span>${esc(warning || "当前没有拿到图片模型返回结果，请检查模型配置后重新生成。")}</span>
          </div>
        `}
      </div>
      <div class="board-info">
        <h4>${esc(shot.no)} ${esc(shot.type)}</h4>
        <p>${esc(shot.content)}</p>
        ${shot.refData ? `<div class="board-refbox"><img class="board-ref" src="${shot.refData}" alt="${esc(shot.refName)}" /><span>参考图：${esc(shot.refName)}</span></div>` : ""}
        ${warning ? `<p class="board-warning">${esc(warning)}</p>` : ""}
        <div class="board-tags"><span class="tag">${esc(shot.shotSize)}</span><span class="tag">${esc(shot.angle)}</span><span class="tag">${esc(shot.camera)}</span><span class="tag">${esc(compact(shot.blocking, 12))}</span><span class="tag">${esc(shot.transition)}</span><span class="tag">${esc(els.boardStyle.value)}</span><span class="tag">${sourceTag}</span>${hasAiImage && shot.boardModel ? `<span class="tag">${esc(shot.boardModel)}</span>` : ""}<span class="tag">${shot.refData ? "含参考图" : "未上传参考图"}</span></div>
      </div>
    </article>`;
  }).join("");
  renderSummary();
}

function imagePayload(confirmed) {
  const overallColorTone = tagText(els.tone.value, 3);
  const overallVisualStyle = tagText(els.visualStyle.value, 3);
  return {
    project: state.project,
    boardStyle: els.boardStyle.value,
    tone: overallColorTone,
    visualStyle: overallVisualStyle,
    overallColorTone,
    overallVisualStyle,
    creativity: els.creativity.value,
    shotCount: els.shotTarget.value.trim(),
    globalNotes: els.globalNotes.value.trim(),
    shots: confirmed.map((shot) => ({
      no: shot.no,
      type: shot.type,
      content: shot.content,
      shotSize: shot.shotSize,
      angle: shot.angle,
      camera: shot.camera,
      blocking: shot.blocking,
      transition: shot.transition,
      duration: shot.duration,
      people: shot.people,
      location: shot.location,
      props: shot.props,
      product: shot.product,
      time: shot.time,
      dialogue: shot.dialogue,
      narration: shot.narration,
      focus: shot.focus,
      refMeta: shot.refMeta || null,
    })),
  };
}

function exportPayload(format) {
  syncAnalysisFromInputs();
  const overallColorTone = tagText(els.tone.value, 3);
  const overallVisualStyle = tagText(els.visualStyle.value, 3);
  return {
    format,
    project: state.project,
    script: els.scriptInput.value.trim(),
    globalNotes: els.globalNotes.value.trim(),
    detected: normalizeAnalysisData(state.detected),
    includeDialogue: true,
    includeNarration: true,
    boardStyle: els.boardStyle.value,
    tone: overallColorTone,
    visualStyle: overallVisualStyle,
    overallColorTone,
    overallVisualStyle,
    creativity: els.creativity.value,
    creativityLabel: creativityLabel(),
    shotCount: els.shotTarget.value.trim(),
    boardsGenerated: state.boardsGenerated,
    shots: state.shots.map((shot) => ({
      no: shot.no,
      type: shot.type,
      content: shot.content,
      shotSize: shot.shotSize,
      angle: shot.angle,
      camera: shot.camera,
      blocking: shot.blocking,
      transition: shot.transition,
      duration: shot.duration,
      people: shot.people,
      location: shot.location,
      props: shot.props,
      product: shot.product,
      time: shot.time,
      dialogue: shot.dialogue,
      narration: shot.narration,
      focus: shot.focus,
      status: shot.status,
      refName: shot.refName,
      boardImage: shot.boardImage || "",
      boardSource: shot.boardSource || "",
      boardModel: shot.boardModel || "",
      boardWarning: shot.boardWarning || "",
      hasBoardImage: Boolean(shot.boardImage),
    })),
  };
}

function filenameFromDisposition(header, fallback) {
  const value = String(header || "");
  const utf8Match = value.match(/filename\\*=UTF-8''([^;]+)/i);
  if (utf8Match) return decodeURIComponent(utf8Match[1]);
  const match = value.match(/filename="?([^";]+)"?/i);
  return match ? match[1] : fallback;
}

async function exportProject(format, button) {
  if (!canUseBackend()) return showToast("请使用打开本地网页.command 或线上地址导出文件。");
  if (!state.shots.length) return showToast("请先拆解分镜，再导出文件。");
  syncProjectFromForm();
  const buttonText = button.textContent;
  button.disabled = true;
  button.textContent = "导出中...";
  try {
    const response = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(exportPayload(format)),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "导出失败");
    }
    const blob = await response.blob();
    const filename = filenameFromDisposition(response.headers.get("Content-Disposition"), `AI分镜拆解助手导出.${format}`);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast(`已导出 ${filename}`);
  } catch (error) {
    console.warn(error);
    showToast(error.message || "导出失败。");
  } finally {
    button.disabled = false;
    button.textContent = buttonText;
  }
}

async function requestStoryboardImages(confirmed) {
  const response = await fetch("/api/storyboard/images", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(imagePayload(confirmed)),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "图片生成接口请求失败。");
  if (data.images) return data;
  if (!data.jobId) throw new Error("图片生成任务创建失败。");
  return pollStoryboardImageJob(data.jobId);
}

async function pollStoryboardImageJob(jobId) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10 * 60 * 1000) {
    await sleep(2000);
    const response = await fetch(`/api/storyboard/images/jobs?id=${encodeURIComponent(jobId)}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "图片生成任务查询失败。");
    if (data.status === "done") return data.result || {};
    if (data.status === "failed") throw new Error(data.error || "图片生成任务失败。");
  }
  throw new Error("图片生成等待超时，请稍后重试。");
}

async function generateBoards() {
  syncProjectFromForm();
  const confirmed = state.shots.filter((shot) => shot.status === "已确认");
  if (!confirmed.length) return showToast("请先确认至少一个镜头。");
  if (!els.boardStyle.value) return showToast("请先选择分镜图类型，再生成分镜图。");
  await hydrateMissingReferenceMeta();
  confirmed.forEach((shot) => {
    shot.boardWarning = "";
    shot.boardImage = "";
    shot.boardSource = "";
    shot.boardModel = "";
  });
  const button = $("#generate");
  const text = button.textContent;
  button.disabled = true;
  button.textContent = "调用生图中...";
  try {
    const result = await requestStoryboardImages(confirmed);
    (result.images || []).forEach((item) => {
      const shot = confirmed.find((candidate) => candidate.no === item.no);
      if (!shot) return;
      shot.boardImage = item.image || "";
      shot.boardSource = item.source || result.source || "ai-image";
      shot.boardModel = item.model || result.model || "";
    });
    const generatedCount = confirmed.filter((shot) => shot.boardImage).length;
    if (!generatedCount) throw new Error("图片模型没有返回可用图片。");
    confirmed.forEach((shot) => {
      if (!shot.boardImage) shot.boardWarning = "图片模型没有返回这一镜头的图片，当前未生成图片。";
    });
    showToast(generatedCount === confirmed.length ? `已生成 ${generatedCount} 张真实分镜图。` : `已生成 ${generatedCount} 张，未返回的镜头标记为未生成。`);
  } catch (error) {
    console.warn(error);
    confirmed.forEach((shot) => {
      shot.boardImage = "";
      shot.boardWarning = `图片生成失败：${error.message || "未知错误"}`;
    });
    showToast("图片生成失败，请检查API和图片模型。");
  } finally {
    state.boardsGenerated = true;
    renderBoards();
    saveCurrentProject();
    button.disabled = false;
    button.textContent = text;
  }
}

function changeBoardStyle(style) {
  const next = style || els.boardStyle.value;
  const changed = els.boardStyle.value !== next;
  if (!changed) {
    renderBoards();
    saveCurrentProject();
    showToast(`当前已是${next}，点击“生成分镜图”重新调用图片模型。`);
    return;
  }
  els.boardStyle.value = next;
  state.shots.forEach((shot) => {
    shot.boardImage = "";
    shot.boardWarning = "";
    shot.boardSource = "";
    shot.boardModel = "";
  });
  state.boardsGenerated = false;
  renderBoards();
  saveCurrentProject();
  if (changed) {
    showToast(`已切换为${next}，请重新点击生成分镜图。`);
  }
}

function syncAnalysisFromInputs() {
  els.analysisGrid.querySelectorAll("[data-analysis]").forEach((node) => {
    state.detected[node.dataset.analysis] = parseList(node.value);
  });
  state.includeDialogue = true;
  state.includeNarration = true;
}

async function analyzeScript() {
  syncProjectFromForm();
  const script = els.scriptInput.value.trim();
  if (!script) return showToast("请先输入或上传脚本。");
  const analyzeButton = $("#analyze");
  const buttonText = analyzeButton.textContent;
  analyzeButton.disabled = true;
  analyzeButton.textContent = "正在分析...";
  try {
    const data = await requestScriptAnalysis();
    state.detected = normalizeAnalysisData(data.analysis);
    const count = applySuggestedShotCount();
    if (data.warning) showToast(`${data.warning} 已建议拆成 ${count} 个镜头。`);
    else showToast(data.source === "ai" ? `AI 已完成剧本分析，建议拆成 ${count} 个镜头，可修改后再拆解。` : `已使用后端演示模式分析剧本，建议拆成 ${count} 个镜头。`);
  } catch (error) {
    console.warn(error);
    if (isAuthError(error)) {
      state.currentUser = null;
      resetWorkspace();
      updateAuthUi();
      setScreen("login");
      showToast("登录已过期，请重新登录。");
      analyzeButton.disabled = false;
      analyzeButton.textContent = buttonText;
      return;
    }
    state.detected = detectTerms(script);
    const count = applySuggestedShotCount();
    showToast(`后端未连接，已使用前端本地分析，建议拆成 ${count} 个镜头。`);
  }
  renderAnalysis();
  renderSummary();
  saveCurrentProject();
  analyzeButton.disabled = false;
  analyzeButton.textContent = buttonText;
}

function openSample() {
  state.projectId = newProjectId();
  applyProject({ ...DEFAULT_PROJECT });
  els.scriptInput.value = sampleScript;
  els.globalNotes.value = "";
  els.shotTarget.value = "";
  els.tone.value = DEFAULT_TONE;
  els.visualStyle.value = DEFAULT_VISUAL_STYLE;
	  els.creativity.value = "60";
	  updateCreativityUi();
	  syncAllChoiceButtons();
	  renderLookTagEditors();
	  state.detected = detectTerms(sampleScript);
  state.shots = [];
  state.boardsGenerated = false;
  renderAnalysis();
  renderShots();
  renderBoards();
  setScreen("workbench");
  saveCurrentProject();
  showToast("已载入示例项目。");
}

function addShot() {
  const i = state.shots.length;
  state.shots.push({
    id: `${Date.now()}-${i}`, no: String(i + 1).padStart(2, "0"), type: "新增镜头", content: "请补充画面内容。",
    shotSize: "中景", duration: "3s", angle: "正面平视", camera: "固定镜头", blocking: "人物停留在画面中央，面向主要主体。", people: first(state.detected.people, "待补充人物"),
    location: first(state.detected.locations, "待补充地点"), props: first(state.detected.props, "待补充道具"),
    product: first(state.detected.product, "待补充产品"), time: first(state.detected.times, "待补充时间段"),
    transition: i === 0 ? "开场建立" : "直切承接", dialogue: "无台词", narration: "无旁白", focus: "待补充", status: "待确认", refName: "", refData: "", refMeta: null,
  });
  renderShots(); renderSummary(); saveCurrentProject();
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("参考图读取失败"));
    image.src = dataUrl;
  });
}

async function analyzeReferenceImage(dataUrl) {
  const image = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  const width = 28;
  const height = 16;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, width, height);
  const pixels = ctx.getImageData(0, 0, width, height).data;
  let total = 0;
  let sx = 0;
  let sy = 0;
  let bright = 0;
  let warm = 0;
  let left = 0;
  let right = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const px = (i / 4) % width;
    const py = Math.floor(i / 4 / width);
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    const saturation = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
    const mass = Math.max(0.04, (1 - lum) * 0.75 + saturation * 0.35);
    total += mass;
    sx += (px + 0.5) * mass;
    sy += (py + 0.5) * mass;
    bright += lum;
    warm += (r - b + 255) / 510;
    if (px < width / 2) left += mass;
    else right += mass;
  }
  const subjectX = total ? sx / total / width : 0.5;
  const subjectY = total ? sy / total / height : 0.52;
  return {
    subjectX: Number(subjectX.toFixed(3)),
    subjectY: Number(subjectY.toFixed(3)),
    aspect: Number((image.width / image.height).toFixed(3)),
    brightness: Number((bright / (pixels.length / 4)).toFixed(3)),
    warmth: Number((warm / (pixels.length / 4)).toFixed(3)),
    balance: left > right * 1.18 ? "left" : right > left * 1.18 ? "right" : "center",
    extractedAt: new Date().toISOString(),
  };
}

async function hydrateMissingReferenceMeta() {
  const pending = state.shots.filter((shot) => shot.refData && !shot.refMeta);
  if (!pending.length) return;
  for (const shot of pending) {
    try {
      shot.refMeta = await analyzeReferenceImage(shot.refData);
    } catch (error) {
      console.warn(error);
    }
  }
  if (state.boardsGenerated) renderBoards();
  saveCurrentProject();
}

function bindEvents() {
  $("#apiBtn").addEventListener("click", () => { els.apiDialog.showModal(); loadApiConfig(); });
  document.addEventListener("click", (event) => {
    const button = event.target.closest(".choice-pill[data-choice-value]");
    if (button) handleChoiceButton(button);
    const remove = event.target.closest("[data-tag-remove]");
    if (remove) {
      const field = remove.dataset.tagRemove;
      const values = lookValues(field).filter((value) => value !== remove.dataset.tagValue);
      setLookValues(field, values, true);
    }
    const add = event.target.closest("[data-tag-add]");
    if (add) addLookTag(add.dataset.tagAdd);
  });
  document.addEventListener("keydown", (event) => {
    const input = event.target.closest("[data-tag-input]");
    if (!input || event.key !== "Enter") return;
    event.preventDefault();
    addLookTag(input.dataset.tagInput);
  });
  els.authBtn.addEventListener("click", () => showToast(`当前账号：${state.currentUser?.email || "未登录"}`));
  els.authForm.addEventListener("submit", (event) => event.preventDefault());
  els.loginBtn.addEventListener("click", () => submitAuth("login"));
  els.registerBtn.addEventListener("click", () => submitAuth("register"));
  els.logoutBtn.addEventListener("click", logout);
  $("#apiSave").addEventListener("click", saveApiConfig);
  document.querySelectorAll("[data-export]").forEach((btn) => btn.addEventListener("click", () => exportProject(btn.dataset.export, btn)));
  els.dashboard.addEventListener("click", async (event) => {
    if (event.target.id === "openSample") return openSample();
    if (event.target.id === "openNew") return startNewProjectSetup();
    const openId = event.target.dataset.openProject;
    if (openId) {
      const record = loadSavedProjects().find((item) => item.id === openId);
      restoreProject(record);
      return;
    }
    const deleteId = event.target.dataset.deleteProject;
    if (deleteId && confirm("确定删除这个本地保存的项目吗？")) {
      writeSavedProjects(loadSavedProjects().filter((item) => item.id !== deleteId));
      await deleteRemoteProject(deleteId);
      if (state.projectId === deleteId) state.projectId = "";
      renderDashboard();
      showToast("项目已从本地看板删除。");
    }
  });
  $("#toDashboard").addEventListener("click", () => { saveCurrentProject(); setScreen("dashboard"); });
  $("#newProject").addEventListener("click", startNewProjectSetup);
  $("#backDashboard").addEventListener("click", () => setScreen("dashboard"));
  $("#createProject").addEventListener("click", () => { state.projectId = newProjectId(); syncProjectFromForm(); setScreen("workbench"); saveCurrentProject(); });
  $("#sampleBtn").addEventListener("click", openSample);
  $("#analyze").addEventListener("click", analyzeScript);
  $("#split").addEventListener("click", splitStoryboard);
  $("#addShot").addEventListener("click", addShot);
  $("#confirmAll").addEventListener("click", () => { state.shots.forEach((s) => s.status = "已确认"); state.boardsGenerated = false; renderShots(); renderBoards(); saveCurrentProject(); });
  $("#generate").addEventListener("click", generateBoards);
  els.boardStyle.addEventListener("change", () => changeBoardStyle(els.boardStyle.value));
  $("#clearScript").addEventListener("click", () => { els.scriptInput.value = ""; state.shots = []; state.boardsGenerated = false; renderShots(); renderBoards(); saveCurrentProject(); });
  $("#uploadTab").addEventListener("click", () => { $("#uploadTab").classList.add("active"); $("#directTab").classList.remove("active"); els.uploadBox.classList.remove("hidden"); });
  $("#directTab").addEventListener("click", () => { $("#directTab").classList.add("active"); $("#uploadTab").classList.remove("active"); els.uploadBox.classList.add("hidden"); });
  els.fileInput.addEventListener("change", async () => {
    const file = els.fileInput.files?.[0];
    if (!file) return;
    els.fileStatus.textContent = `正在读取 ${file.name}...`;
    try {
      const data = await requestScriptImport(file);
      els.scriptInput.value = String(data.text || "").trim();
      state.detected = emptyDetected();
      state.shots = [];
      state.boardsGenerated = false;
      els.shotTarget.value = "";
      renderAnalysis();
      renderShots();
      renderBoards();
      els.fileStatus.textContent = `已读取 ${data.filename || file.name}，共 ${data.length || els.scriptInput.value.length} 字。`;
      showToast("脚本文件已导入。");
      scheduleAutoSave();
    } catch (error) {
      console.warn(error);
      if (/\.(txt|md|csv)$/i.test(file.name)) {
        els.scriptInput.value = (await file.text()).trim();
        els.fileStatus.textContent = `已本地读取 ${file.name}。`;
        scheduleAutoSave();
        return;
      }
      els.fileStatus.textContent = `读取失败：${error.message || "无法解析该文件"}`;
      showToast(error.message || "文件读取失败。");
    }
  });
  els.scriptInput.addEventListener("input", scheduleAutoSave);
  els.globalNotes.addEventListener("input", scheduleAutoSave);
  els.shotTarget.addEventListener("input", scheduleAutoSave);
  els.creativity.addEventListener("input", () => { updateCreativityUi(); scheduleAutoSave(); });
  els.workbenchDuration.addEventListener("input", () => { syncProjectFromForm(); scheduleAutoSave(); });
  els.analysisGrid.addEventListener("input", () => { syncAnalysisFromInputs(); scheduleAutoSave(); });
  els.analysisGrid.addEventListener("change", () => { syncAnalysisFromInputs(); scheduleAutoSave(); });
  els.shots.addEventListener("input", (event) => {
    const card = event.target.closest(".shot-card");
    const field = event.target.dataset.field;
    if (!card || !field) return;
    const shot = state.shots[Number(card.dataset.index)];
    shot[field] = event.target.value;
    if (shot.status === "已确认") shot.status = "待确认";
    state.boardsGenerated = false;
    renderSummary();
    scheduleAutoSave();
  });
  els.shots.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-chip]");
    if (chip) {
      const card = chip.closest(".shot-card");
      const shot = state.shots[Number(card.dataset.index)];
      const field = chip.dataset.chip;
      const values = parseList(shot[field]);
      shot[field] = (values.includes(chip.dataset.value) ? values.filter((x) => x !== chip.dataset.value) : [...values, chip.dataset.value]).join("、");
      renderShots(); saveCurrentProject(); return;
    }
    const action = event.target.dataset.action;
    if (!action) return;
    const index = Number(event.target.closest(".shot-card").dataset.index);
    const shot = state.shots[index];
    if (action === "confirm") shot.status = "已确认";
    if (action === "unconfirm") shot.status = "待确认";
    if (action === "revise") shot.status = "需修改";
    if (action === "regen-shot") {
      regenerateShotFromFields(shot);
      showToast("已按当前字段更新这一镜头的画面内容。");
    }
    if (action === "remove-ref") {
      shot.refName = "";
      shot.refData = "";
      shot.refMeta = null;
      shot.boardImage = "";
      shot.boardWarning = "";
      shot.boardSource = "";
      shot.boardModel = "";
      if (shot.status === "已确认") shot.status = "待确认";
      showToast("已删除这个镜头的参考图。");
    }
    if (action === "delete") {
      state.shots.splice(index, 1);
      state.shots.forEach((item, i) => item.no = String(i + 1).padStart(2, "0"));
    }
    state.boardsGenerated = false;
    renderShots(); renderBoards(); saveCurrentProject();
  });
  els.shots.addEventListener("change", async (event) => {
    if (!event.target.dataset.ref) return;
    const index = Number(event.target.dataset.ref);
    const file = event.target.files?.[0];
    if (!file || !file.type.startsWith("image/")) return showToast("请上传图片文件。");
    const dataUrl = await readAsDataUrl(file);
    state.shots[index].refData = dataUrl;
    state.shots[index].refName = file.name;
    try {
      state.shots[index].refMeta = await analyzeReferenceImage(dataUrl);
    } catch (error) {
      console.warn(error);
      state.shots[index].refMeta = null;
      showToast("参考图已上传，但构图分析失败。");
    }
    if (state.shots[index].status === "已确认") state.shots[index].status = "待确认";
    state.boardsGenerated = false;
    renderShots(); renderBoards(); saveCurrentProject(); showToast("参考图已上传，已提取构图参考。");
  });
  ["projectName", "projectType", "duration", "aspect", "style", "platform"].forEach((id) => $(`#${id}`).addEventListener("input", () => { syncProjectFromForm(); scheduleAutoSave(); }));
  ["projectType", "aspect", "style", "platform"].forEach((id) => $(`#${id}`).addEventListener("blur", () => {
    if (id === "style") normalizeTagInput($(`#${id}`));
    else syncChoiceButtons(id);
    syncProjectFromForm();
    scheduleAutoSave();
  }));
  els.boardStyle.addEventListener("input", scheduleAutoSave);
}

renderDashboard();
bindEvents();
applyProject(state.project);
renderAnalysis();
renderShots();
renderBoards();
updateCreativityUi();
syncAllChoiceButtons();
renderLookTagEditors();
setScreen("login");
loadSession();
