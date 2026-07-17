const sampleScript = "清晨，一位年轻上班族骑着新能源电动车穿过城市街道。车辆启动平稳，行驶安静，智能仪表清晰显示速度和电量。镜头展现车辆外观、驾驶体验和城市通勤场景，突出轻便、安全、智能的产品特点。最后，主人公到达办公楼前，轻松停车，画面出现品牌口号。";
const STORAGE_KEY = "ai-storyboard-projects-v1";

const state = {
  projectId: "",
  currentUser: null,
  screen: "login",
  project: { name: "30秒新能源电动车广告", type: "广告片", duration: 30, aspect: "9:16", style: "真实广告", platform: "抖音" },
  detected: emptyDetected(),
  includeDialogue: false,
  includeNarration: false,
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
  projectName: $("#projectName"), projectType: $("#projectType"), duration: $("#duration"), aspect: $("#aspect"), style: $("#style"), platform: $("#platform"),
  scriptInput: $("#scriptInput"), uploadBox: $("#uploadBox"), fileInput: $("#fileInput"), fileStatus: $("#fileStatus"),
  analysisGrid: $("#analysisGrid"), shots: $("#shots"), boards: $("#boards"),
  shotCount: $("#shotCount"), confirmedCount: $("#confirmedCount"), boardCount: $("#boardCount"), summary: $("#summary"), notice: $("#notice"),
  boardStyle: $("#boardStyle"), tone: $("#tone"), visualStyle: $("#visualStyle"), creativity: $("#creativity"), apiDialog: $("#apiDialog"), toast: $("#toast"),
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

function listText(items, fallback = "待补充") {
  return items.length ? items.join("、") : fallback;
}

function isAuthError(error) {
  return Number(error?.status || 0) === 401;
}

function first(items, fallback) {
  return items[0] || fallback;
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
    showToast("本地保存空间不足，参考图过大时可先不保存图片。");
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
    || state.shots.length
    || Object.values(state.detected).some((items) => Array.isArray(items) && items.length)
  );
}

function projectSnapshot() {
  return {
    id: state.projectId || newProjectId(),
    updatedAt: new Date().toISOString(),
    project: { ...state.project },
    script: els.scriptInput.value,
    detected: normalizeAnalysisData(state.detected),
    includeDialogue: state.includeDialogue,
    includeNarration: state.includeNarration,
    shots: state.shots,
    boardsGenerated: state.boardsGenerated,
    boardStyle: els.boardStyle.value,
    tone: els.tone.value,
    visualStyle: els.visualStyle.value,
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
    <article>
      <span class="tag">平台设置</span>
      <h4>API 接入</h4>
      <p>API Key 属于平台级配置，不写入项目导出，避免和项目资料混在一起。</p>
      <button class="text-btn" id="apiCardBtn">打开 API 设置</button>
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
  state.includeDialogue = Boolean(record.includeDialogue);
  state.includeNarration = Boolean(record.includeNarration);
  state.shots = Array.isArray(record.shots) ? record.shots : [];
  state.boardsGenerated = Boolean(record.boardsGenerated);
  applyProject(state.project);
  els.scriptInput.value = record.script || "";
  els.boardStyle.value = record.boardStyle || "线稿";
  els.tone.value = record.tone || "清爽蓝绿";
  els.visualStyle.value = record.visualStyle || state.project.style || "真实广告";
  renderAnalysis();
  renderShots();
  renderBoards();
  renderSummary();
  setScreen("workbench");
  state.hydrating = false;
}

function resetWorkspace() {
  state.hydrating = true;
  state.projectId = "";
  state.project = { name: "30秒新能源电动车广告", type: "广告片", duration: 30, aspect: "9:16", style: "真实广告", platform: "抖音" };
  state.detected = emptyDetected();
  state.includeDialogue = false;
  state.includeNarration = false;
  state.shots = [];
  state.boardsGenerated = false;
  applyProject(state.project);
  els.scriptInput.value = "";
  els.boardStyle.value = "线稿";
  els.tone.value = "清爽蓝绿";
  els.visualStyle.value = "真实广告";
  renderAnalysis();
  renderShots();
  renderBoards();
  renderSummary();
  state.hydrating = false;
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
    duration: Math.max(1, Number(els.duration.value || 30)),
    aspect: els.aspect.value || "未填写",
    style: els.style.value || "未填写",
    platform: els.platform.value || "未填写",
  };
  if (!els.visualStyle.value.trim() && els.style.value) els.visualStyle.value = els.style.value;
  renderSummary();
}

function applyProject(project) {
  els.projectName.value = project.name || "";
  els.projectType.value = project.type || "";
  els.duration.value = project.duration || 30;
  els.aspect.value = project.aspect || "";
  els.style.value = project.style || "";
  els.platform.value = project.platform || "";
  syncProjectFromForm();
}

function detectTerms(script) {
  const has = (word) => script.includes(word);
  const people = unique(["年轻上班族", "主人公", "主角", "用户", "顾客", "年轻女性", "年轻男性", "女性用户", "男性用户", "学生", "妈妈", "孩子", "老人", "员工", "同事", "朋友", "家人", "店员", "客户", "讲述者"].filter(has));
  const product = unique(["新能源电动车", "健康饮食APP", "电动车", "车辆", "汽车", "手机", "APP", "小程序", "咖啡", "饮料", "护肤品", "课程", "产品", "服务"].filter(has));
  const locations = unique(["办公楼前", "城市街道", "通勤路口", "城市道路", "路口", "办公室", "会议室", "家中", "客厅", "厨房", "门店", "商场", "校园", "公园", "地铁站", "室内", "户外"].filter(has));
  const props = unique(["智能仪表", "车把", "启动键", "车轮", "头盔", "背包", "电量", "速度", "品牌口号", "手机", "电脑", "杯子", "海报", "包装", "屏幕", "早餐", "食物", "界面"].filter(has));
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

function analysisCard(field, title, desc, optionKey) {
  const value = (state.detected[field] || []).join("\n");
  const toggle = optionKey ? `<label class="toggle"><input type="checkbox" data-option="${optionKey}" ${state[optionKey] ? "checked" : ""} />带入分镜</label>` : "";
  return `<article class="analysis-card">
    ${toggle}
    <label><span>${title}</span><textarea data-analysis="${field}">${esc(value)}</textarea></label>
    <p>${desc}</p>
  </article>`;
}

function renderAnalysis() {
  els.analysisGrid.innerHTML = [
    analysisCard("people", "人物", "可识别多个，也可自行新增。"),
    analysisCard("locations", "场景", "这里是地点场景，不是清晨这类时间段。"),
    analysisCard("props", "道具", "包括车把、仪表、背包等画面元素。"),
    analysisCard("product", "产品", "主要产品或服务。"),
    analysisCard("times", "时间段", "清晨、上午、夜晚等。"),
    analysisCard("sellingPoints", "卖点", "轻便、安全、智能等。"),
    analysisCard("dialogue", "台词", "明确台词时再带入。", "includeDialogue"),
    analysisCard("narration", "旁白", "明确旁白时再带入。", "includeNarration"),
  ].join("");
}

function storyboardBank() {
  return [
    ["地点建立", "办公楼前建立镜头，年轻上班族推着新能源电动车进入画面，先交代地点、人物和产品关系。", "远景", "固定轻推", "道路线、环境", "地点、人物、产品关系"],
    ["启动细节", "手部特写触发车辆启动，智能仪表亮起，表现启动平稳和操作轻便。", "特写", "微距推进", "车把、启动键、智能仪表", "启动细节与智能感"],
    ["创意机位", "低机位贴近车轮跟拍，车辆从城市街道轻快经过，地面线条快速后退。", "近景", "低机位跟拍", "车轮、道路线", "轻便、速度与稳定"],
    ["驾驶体验", "人物骑行经过路口，背景自然后移，画面重点放在安静、顺滑和真实通勤状态。", "中远景", "横向跟拍", "头盔、背包", "通勤体验"],
    ["信息特写", "智能仪表清晰显示速度和电量，画面干净，不堆砌信息。", "特写", "轻微推进", "智能仪表、电量、速度", "智能卖点"],
    ["安全瞬间", "人物在关键位置完成观察、停顿或确认动作，让安全感通过动作表达。", "中景", "跟随转定镜", "车灯、道路线", "安全感"],
    ["轻松收尾", "人物到达办公楼前轻松停车，车辆停在画面前景，人物状态轻松。", "中景", "小幅环绕", "停车点、背包", "轻松收尾"],
    ["口号留白", "广告收束，人物与车辆形成最后记忆点，画面侧边预留口号或字幕位置。", "广角", "慢慢拉远", "品牌口号占位", "品牌记忆"],
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
  if (/手|眼神|表情|电脑|手机|杯|道具|细节|特写/.test(text)) return index ? "特写" : "近景";
  if (index === 0) return "远景";
  if (index === total - 1) return "中景";
  return ["中景", "近景", "中远景"][index % 3];
}

function inferCamera(text, index) {
  if (/走|跑|穿过|移动|经过|骑|跟/.test(text)) return "跟拍";
  if (/看|相视|对视|发现|望|笑/.test(text)) return "轻推至反应";
  if (/放下|拿起|递|打开|启动/.test(text)) return "微距推进";
  return ["固定镜头", "缓慢推进", "横向轻移", "小幅环绕"][index % 4];
}

function localShotType(text, index, total) {
  if (index === 0) return "场景建立";
  if (index === total - 1) return "情绪收束";
  if (/电脑|手机|杯|道具|手|细节/.test(text)) return "细节强调";
  if (/看|笑|相视|对话|说/.test(text)) return "关系反应";
  return "动作推进";
}

function localStoryboardShots() {
  const duration = Math.max(1, Number(els.duration.value || 30));
  let units = scriptUnits(els.scriptInput.value);
  if (!units.length) {
    units = [
      `在${first(state.detected.locations, "主要场景")}建立人物和空间关系`,
      `围绕${first(state.detected.props, first(state.detected.product, "核心物件"))}呈现关键动作`,
      "捕捉人物反应和情绪变化",
      "用留白或稳定构图完成收束",
    ];
  }
  const total = duration >= 15 ? Math.min(8, Math.max(4, units.length)) : Math.min(6, Math.max(3, units.length));
  while (units.length < total) units.push(units[units.length - 1]);
  units = units.slice(0, total);
  const base = Math.floor(duration / units.length);
  let remain = duration - base * units.length;
  let currentLocation = first(state.detected.locations, "");
  return units.map((unit, i) => ({
    id: `${Date.now()}-${i}`,
    no: String(i + 1).padStart(2, "0"),
    type: localShotType(unit, i, units.length),
    content: unit,
    shotSize: inferShotSize(unit, i, units.length),
    camera: inferCamera(unit, i),
    duration: `${base + (remain-- > 0 ? 1 : 0)}s`,
    people: pickFromText(state.detected.people, unit, "待补充人物", i),
    location: (currentLocation = state.detected.locations.find((item) => unit.includes(item)) || currentLocation || "待补充地点"),
    props: state.detected.props.find((item) => unit.includes(item)) || inferPropText(unit),
    product: pickFromText(state.detected.product, unit, "待补充产品", i),
    time: pickFromText(state.detected.times, unit, "待补充时间段", i),
    dialogue: state.includeDialogue ? pickFromText(state.detected.dialogue, unit, "无台词", i) : "无台词",
    narration: state.includeNarration ? pickFromText(state.detected.narration, unit, "无旁白", i) : "无旁白",
    focus: pickFromText(state.detected.sellingPoints, unit, "画面关系与情绪变化", i),
    status: "待确认",
    refName: "",
    refData: "",
  }));
}

function textValue(value, fallback = "") {
  if (Array.isArray(value)) return value.filter(Boolean).join("、") || fallback;
  return String(value ?? "").trim() || fallback;
}

function normalizeShot(shot, index) {
  return {
    id: `${Date.now()}-${index}`,
    no: String(shot.no || index + 1).padStart(2, "0"),
    type: textValue(shot.type, "镜头"),
    content: textValue(shot.content, "请补充画面内容。"),
    shotSize: textValue(shot.shotSize, "中景"),
    camera: textValue(shot.camera, "固定镜头"),
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
    refName: "",
    refData: "",
  };
}

function splitPayload() {
  return {
    script: els.scriptInput.value.trim(),
    project: state.project,
    analysis: state.detected,
    includeDialogue: state.includeDialogue,
    includeNarration: state.includeNarration,
    boardStyle: els.boardStyle.value,
    tone: els.tone.value,
    visualStyle: els.visualStyle.value,
    creativity: els.creativity.value,
  };
}

function analysisPayload() {
  return {
    script: els.scriptInput.value.trim(),
    project: state.project,
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

async function splitStoryboard() {
  syncAnalysisFromInputs();
  const script = els.scriptInput.value.trim();
  if (!script) return showToast("请先输入或上传脚本。");
  const splitButton = $("#split");
  const buttonText = splitButton.textContent;
  splitButton.disabled = true;
  splitButton.textContent = "正在拆解...";

  try {
    const data = await requestStoryboardSplit();
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
  const payload = {
    name: els.authName.value.trim(),
    email: els.authEmail.value.trim(),
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
    state.currentUser = data.user;
    updateAuthUi(data.config);
    els.authPassword.value = "";
    await loadRemoteProjects();
    setScreen("dashboard");
    saveCurrentProject();
    showToast(mode === "login" ? "登录成功。" : "注册成功。");
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
  return `<div class="reference-row">
    ${preview}
    <div class="reference-meta"><strong>分镜参考图</strong><span>${shot.refName ? `已上传：${esc(shot.refName)}` : "可选上传线稿、截图或参考图，辅助生成这一镜头的分镜图。"}</span></div>
    <div><input class="reference-input" id="ref-${index}" type="file" accept="image/*" data-ref="${index}" /><label class="mini" for="ref-${index}">上传图片</label></div>
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
          <div class="shot-meta-row">${input("shotSize", shot.shotSize, "景别")}${input("duration", shot.duration, "时长")}${input("camera", shot.camera, "运镜")}</div>
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
        <button class="mini" data-action="confirm">确认此镜头</button>
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
  return [shot.content, shot.people, shot.location, shot.props, shot.product, shot.time, shot.focus, shot.dialogue, shot.narration].join(" ");
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
  const tone = `${els.tone.value} ${els.visualStyle.value}`;
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

function propSvg(shot, palette, close = false) {
  const text = textBlob(shot);
  const s = close ? 1.55 : 1;
  const y = close ? 176 : 220;
  if (hasAny(text, ["电脑", "屏幕", "笔记本"])) {
    return `<g transform="translate(${close ? 214 : 278},${close ? 142 : y}) scale(${s})" stroke="${palette.line}" stroke-width="3" fill="${palette.fill ? "#c9d7ef" : "none"}">
      <rect x="0" y="0" width="114" height="70" rx="5"/><path d="M20 82 H98 L112 104 H6 Z"/><line x1="20" y1="18" x2="92" y2="18"/><line x1="20" y1="38" x2="74" y2="38"/>
    </g>`;
  }
  if (hasAny(text, ["杯", "水", "咖啡", "饮料"])) {
    return `<g transform="translate(${close ? 300 : 398},${close ? 160 : y}) scale(${s})" stroke="${palette.line}" stroke-width="3" fill="${palette.fill ? "#f4f7fb" : "none"}">
      <path d="M0 8 H60 L52 82 H8 Z"/><path d="M60 22 C96 20 94 68 55 64" fill="none"/><path d="M12 24 H50"/>
    </g>`;
  }
  if (hasAny(text, ["书", "资料", "文件"])) {
    return `<g transform="translate(${close ? 224 : 350},${close ? 170 : y + 16}) scale(${s})" stroke="${palette.line}" stroke-width="3" fill="${palette.fill ? "#ffe7a5" : "none"}">
      <path d="M0 0 L82 12 V78 L0 64 Z"/><path d="M82 12 L118 0 V64 L82 78 Z"/><line x1="22" y1="24" x2="64" y2="30"/>
    </g>`;
  }
  if (hasAny(text, ["手机", "APP", "界面"])) {
    return `<g transform="translate(${close ? 280 : 388},${close ? 130 : y}) scale(${s})" stroke="${palette.line}" stroke-width="3" fill="${palette.fill ? "#e9f2ff" : "none"}">
      <rect x="0" y="0" width="58" height="102" rx="10"/><circle cx="29" cy="88" r="4"/><line x1="14" y1="24" x2="44" y2="24"/><line x1="14" y1="42" x2="44" y2="42"/>
    </g>`;
  }
  if (hasAny(text, ["车", "自行车", "电动车", "汽车"])) {
    return `<g transform="translate(285,224)" stroke="${palette.line}" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round">
      <path d="M35 42 L98 18 L172 34 L220 58"/><circle cx="66" cy="76" r="27"/><circle cx="185" cy="76" r="27"/><path d="M132 28 L160 0 L202 8"/>
    </g>`;
  }
  return `<g transform="translate(${close ? 270 : 360},${close ? 170 : y}) scale(${s})" stroke="${palette.line}" stroke-width="3" fill="${palette.fill ? "#f3d58b" : "none"}">
    <rect x="0" y="0" width="88" height="70" rx="8"/><path d="M14 22 H72 M14 42 H54"/>
  </g>`;
}

function cameraGuideSvg(camera, palette, id) {
  const text = String(camera || "");
  if (hasAny(text, ["跟", "横", "移"])) return `<path d="M80 58 H190" stroke="${palette.accent}" stroke-width="5" marker-end="url(#arrow-${id})"/><text x="82" y="48" font-family="Microsoft YaHei" font-size="13" fill="${palette.accent}">跟随移动</text>`;
  if (hasAny(text, ["推", "推进"])) return `<path d="M560 62 C500 80 468 108 438 150" stroke="${palette.accent}" stroke-width="5" fill="none" marker-end="url(#arrow-${id})"/><text x="456" y="52" font-family="Microsoft YaHei" font-size="13" fill="${palette.accent}">镜头推进</text>`;
  if (hasAny(text, ["拉", "远"])) return `<path d="M430 86 C492 72 532 58 588 42" stroke="${palette.accent}" stroke-width="5" fill="none" marker-end="url(#arrow-${id})"/><text x="442" y="112" font-family="Microsoft YaHei" font-size="13" fill="${palette.accent}">慢慢拉远</text>`;
  if (hasAny(text, ["环", "绕", "摇"])) return `<path d="M472 72 C560 55 600 116 540 164 C486 208 402 174 424 112" stroke="${palette.accent}" stroke-width="5" fill="none" marker-end="url(#arrow-${id})"/><text x="454" y="54" font-family="Microsoft YaHei" font-size="13" fill="${palette.accent}">环绕/摇移</text>`;
  return `<rect x="475" y="38" width="112" height="58" rx="7" fill="none" stroke="${palette.accent}" stroke-width="3"/><text x="494" y="73" font-family="Microsoft YaHei" font-size="13" fill="${palette.accent}">固定构图</text>`;
}

function boardSvg(shot, index) {
  const blob = textBlob(shot);
  const seed = hashText(blob || `${shot.no}-${index}`);
  const palette = boardPalette(seed);
  const close = /特写|近景/.test(String(shot.shotSize || "")) && hasAny(blob, ["手", "电脑", "杯", "手机", "书", "道具", "细节", "表情", "眼神"]);
  const peopleCount = Math.min(3, Math.max(1, parseList(shot.people).filter((item) => !item.includes("待补充")).length || (hasAny(blob, ["两人", "母亲", "女主", "男主", "相视"]) ? 2 : 1)));
  const people = close
    ? `<path d="M118 258 C170 210 230 218 284 260" stroke="${palette.line}" stroke-width="13" fill="none" stroke-linecap="round" opacity=".7"/>`
    : Array.from({ length: peopleCount }, (_, i) => personSvg(150 + i * 74 + (seed % 18), 140 + (i % 2) * 18, /远景|广角/.test(String(shot.shotSize || "")) ? .62 : .82, palette, i)).join("");
  const focusBox = `<rect x="22" y="292" width="596" height="42" rx="8" fill="rgba(255,255,255,.72)" stroke="${palette.line}" stroke-width="2" opacity=".92"/>
    <text x="38" y="318" font-family="Microsoft YaHei" font-size="14" fill="${palette.line}">场景：${esc(compact(shot.location, 12))} · 人物：${esc(compact(shot.people, 12))} · 道具：${esc(compact(shot.props, 12))}</text>`;
  return `<svg viewBox="0 0 640 360" xmlns="http://www.w3.org/2000/svg">
    <defs><marker id="arrow-${index}" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="${palette.accent}"/></marker></defs>
    ${sceneBackgroundSvg(shot, palette, seed)}
    ${people}
    ${propSvg(shot, palette, close)}
    ${cameraGuideSvg(shot.camera, palette, index)}
    <rect x="18" y="18" width="284" height="42" rx="8" fill="rgba(255,255,255,.78)" stroke="${palette.line}" stroke-width="2"/>
    <text x="34" y="45" font-family="Microsoft YaHei" font-size="20" fill="${palette.line}" font-weight="800">${esc(shot.no)} ${esc(compact(shot.type, 10))}</text>
    <text x="318" y="45" font-family="Microsoft YaHei" font-size="15" fill="${palette.line}">${esc(compact(shot.shotSize, 8))} · ${esc(compact(shot.camera, 10))}</text>
    ${focusBox}
    <text x="24" y="350" font-family="Microsoft YaHei" font-size="13" fill="${palette.line}" opacity=".72">${esc(els.boardStyle.value)} · ${esc(compact(els.tone.value, 14))} · 按当前分镜内容生成的参考草图</text>
  </svg>`;
}

function renderBoards() {
  const confirmed = state.shots.filter((shot) => shot.status === "已确认");
  if (!state.boardsGenerated || !confirmed.length) {
    els.boards.innerHTML = `<div class="empty">确认分镜后点击生成分镜图。</div>`;
    renderSummary();
    return;
  }
  els.boards.innerHTML = confirmed.map((shot, i) => `
    <article class="board-card">
      <div class="frame">${boardSvg(shot, i)}</div>
      <div class="board-info">
        <h4>${esc(shot.no)} ${esc(shot.type)}</h4>
        <p>${esc(shot.content)}</p>
        ${shot.refData ? `<div class="board-refbox"><img class="board-ref" src="${shot.refData}" alt="${esc(shot.refName)}" /><span>参考图：${esc(shot.refName)}</span></div>` : ""}
        <div class="board-tags"><span class="tag">${esc(shot.shotSize)}</span><span class="tag">${esc(shot.camera)}</span><span class="tag">${esc(els.boardStyle.value)}</span><span class="tag">${shot.refData ? "含参考图" : "未上传参考图"}</span></div>
      </div>
    </article>`).join("");
  renderSummary();
}

function syncAnalysisFromInputs() {
  els.analysisGrid.querySelectorAll("[data-analysis]").forEach((node) => {
    state.detected[node.dataset.analysis] = parseList(node.value);
  });
  state.includeDialogue = Boolean(els.analysisGrid.querySelector("[data-option='includeDialogue']")?.checked);
  state.includeNarration = Boolean(els.analysisGrid.querySelector("[data-option='includeNarration']")?.checked);
}

async function analyzeScript() {
  const script = els.scriptInput.value.trim();
  if (!script) return showToast("请先输入或上传脚本。");
  const analyzeButton = $("#analyze");
  const buttonText = analyzeButton.textContent;
  analyzeButton.disabled = true;
  analyzeButton.textContent = "正在分析...";
  try {
    const data = await requestScriptAnalysis();
    state.detected = normalizeAnalysisData(data.analysis);
    if (data.warning) showToast(data.warning);
    else showToast(data.source === "ai" ? "AI 已完成剧本分析，可先修改再拆解分镜。" : "已使用后端演示模式分析剧本。");
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
    showToast("后端未连接，已使用前端本地分析。");
  }
  renderAnalysis();
  renderSummary();
  saveCurrentProject();
  analyzeButton.disabled = false;
  analyzeButton.textContent = buttonText;
}

function openSample() {
  state.projectId = newProjectId();
  applyProject({ name: "30秒新能源电动车广告", type: "广告片", duration: 30, aspect: "9:16", style: "真实广告", platform: "抖音" });
  els.scriptInput.value = sampleScript;
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
    shotSize: "中景", duration: "3s", camera: "固定镜头", people: first(state.detected.people, "待补充人物"),
    location: first(state.detected.locations, "待补充地点"), props: first(state.detected.props, "待补充道具"),
    product: first(state.detected.product, "待补充产品"), time: first(state.detected.times, "待补充时间段"),
    dialogue: "无台词", narration: "无旁白", focus: "待补充", status: "待确认", refName: "", refData: "",
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

function bindEvents() {
  $("#apiBtn").addEventListener("click", () => { els.apiDialog.showModal(); loadApiConfig(); });
  els.authBtn.addEventListener("click", () => showToast(`当前账号：${state.currentUser?.email || "未登录"}`));
  els.authForm.addEventListener("submit", (event) => event.preventDefault());
  els.loginBtn.addEventListener("click", () => submitAuth("login"));
  els.registerBtn.addEventListener("click", () => submitAuth("register"));
  els.logoutBtn.addEventListener("click", logout);
  $("#apiSave").addEventListener("click", saveApiConfig);
  els.dashboard.addEventListener("click", async (event) => {
    if (event.target.id === "openSample") return openSample();
    if (event.target.id === "openNew") return setScreen("setup");
    if (event.target.id === "apiCardBtn") { els.apiDialog.showModal(); loadApiConfig(); return; }
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
  $("#newProject").addEventListener("click", () => setScreen("setup"));
  $("#backDashboard").addEventListener("click", () => setScreen("dashboard"));
  $("#createProject").addEventListener("click", () => { state.projectId = newProjectId(); syncProjectFromForm(); setScreen("workbench"); saveCurrentProject(); });
  $("#sampleBtn").addEventListener("click", openSample);
  $("#analyze").addEventListener("click", analyzeScript);
  $("#split").addEventListener("click", splitStoryboard);
  $("#addShot").addEventListener("click", addShot);
  $("#confirmAll").addEventListener("click", () => { state.shots.forEach((s) => s.status = "已确认"); state.boardsGenerated = false; renderShots(); renderBoards(); saveCurrentProject(); });
  $("#generate").addEventListener("click", () => {
    if (!state.shots.some((s) => s.status === "已确认")) return showToast("请先确认至少一个镜头。");
    state.boardsGenerated = true; renderBoards(); saveCurrentProject(); showToast("分镜图已生成。");
  });
  $("#clearScript").addEventListener("click", () => { els.scriptInput.value = ""; state.shots = []; state.boardsGenerated = false; renderShots(); renderBoards(); saveCurrentProject(); });
  $("#uploadTab").addEventListener("click", () => { $("#uploadTab").classList.add("active"); $("#directTab").classList.remove("active"); els.uploadBox.classList.remove("hidden"); });
  $("#directTab").addEventListener("click", () => { $("#directTab").classList.add("active"); $("#uploadTab").classList.remove("active"); els.uploadBox.classList.add("hidden"); });
  els.fileInput.addEventListener("change", async () => {
    const file = els.fileInput.files?.[0];
    if (!file) return;
    if (/\.(txt|md|csv)$/i.test(file.name)) {
      els.scriptInput.value = (await file.text()).trim();
      els.fileStatus.textContent = `已读取 ${file.name}`;
      scheduleAutoSave();
    } else {
      els.fileStatus.textContent = `已选择 ${file.name}。静态演示版保留入口，真实版接后端解析。`;
    }
  });
  els.scriptInput.addEventListener("input", scheduleAutoSave);
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
    if (action === "revise") shot.status = "需修改";
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
    state.shots[index].refData = await readAsDataUrl(file);
    state.shots[index].refName = file.name;
    if (state.shots[index].status === "已确认") state.shots[index].status = "待确认";
    state.boardsGenerated = false;
    renderShots(); renderBoards(); saveCurrentProject(); showToast("参考图已上传。");
  });
  document.querySelectorAll("[data-style]").forEach((btn) => btn.addEventListener("click", () => { els.boardStyle.value = btn.dataset.style; renderBoards(); saveCurrentProject(); }));
  ["projectName", "projectType", "duration", "aspect", "style", "platform"].forEach((id) => $(`#${id}`).addEventListener("input", () => { syncProjectFromForm(); scheduleAutoSave(); }));
  [els.boardStyle, els.tone, els.visualStyle].forEach((node) => node.addEventListener("input", scheduleAutoSave));
}

renderDashboard();
bindEvents();
applyProject(state.project);
renderAnalysis();
renderShots();
renderBoards();
setScreen("login");
loadSession();
