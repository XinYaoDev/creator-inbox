// 视频号/微信把表情存成 [Facepalm]、[捂脸] 这类码，收件箱里换成 Unicode 显示。
// 未收录的 [xxx] 原样留下，避免把普通方括号内容误伤。

const EN: Record<string, string> = {
  smile: '😊', grimace: '😣', drool: '😍', scowl: '😳', coolguy: '😎', cool: '😎',
  sob: '😭', shy: '😊', silent: '🤐', sleep: '😴', cry: '😢', awkward: '😅',
  angry: '😠', tongue: '😜', grin: '😁', surprise: '😮', surprised: '😮', frown: '🙁',
  ruthless: '😎', blush: '☺️', scream: '😫', puke: '🤮', chuckle: '😄', joyful: '😄',
  joy: '😄', laugh: '😂', lol: '🤣', slight: '🙄', smug: '😤', hungry: '😋',
  drowsy: '😪', panic: '😱', sweat: '😅', sweats: '😅', commando: '😎',
  determined: '💪', scold: '🤬', shocked: '❓', shhh: '🤫', dizzy: '😵',
  tormented: '😫', toasted: '😬', skull: '💀', hammer: '🔨', wave: '👋', bye: '👋',
  speechless: '😶', nosepick: '👃', clap: '👏', shame: '😳', trick: '😜',
  bahl: '😤', bahr: '😤', yawn: '🥱', poohpooh: '😒', shrunken: '😞',
  tearingup: '😢', sly: '😏', kiss: '😘', wrath: '😱', whimper: '🥺',
  cleaver: '🔪', watermelon: '🍉', beer: '🍺', basketball: '🏀', pingpong: '🏓',
  coffee: '☕', rice: '🍚', pig: '🐷', rose: '🌹', wilt: '🥀', lips: '💋',
  heart: '❤️', brokenheart: '💔', cake: '🎂', lightning: '⚡', bomb: '💣',
  dagger: '🔪', soccer: '⚽', ladybug: '🐞', poop: '💩', moon: '🌙', sun: '☀️',
  gift: '🎁', hug: '🤗', thumbsup: '👍', thumbsdown: '👎', shake: '🤝',
  peace: '✌️', fight: '🙏', beckon: '👈', fist: '✊', pinky: '👎', rockon: '🤟',
  nuhuh: '🙅', ok: '👌', inlove: '🥰', blowkiss: '😘', waddle: '💫', tremble: '😰',
  aaagh: '💢', twirl: '😵', kotow: '🙇', dramatic: '🙆', jumprope: '🤸',
  surrender: '🙋', hooray: '🎉', meditate: '🧘', smooch: '💋', hey: '😎',
  facepalm: '🤦', smirk: '😏', smart: '🤓', moue: '😣', yeah: '✌️', tea: '🍵',
  packet: '🧧', candle: '🕯️', blessing: '🧧', chick: '🐔', onlooker: '🍿',
  goforit: '💪', omg: '😱', emm: '😐', respect: '🙇', doge: '🐶', noprob: '👌',
  mybad: '🤦', keepfighting: '💪', wow: '😲', rich: '🤑', broken: '💔',
  hurt: '😣', sigh: '😮‍💨', letmesee: '👀', awesome: '👍', boring: '🙄',
  flushed: '😳', concerned: '😟', duh: '🙄', fireworks: '🎆', happy: '😊',
  sick: '🤒', worship: '🙇', shrug: '🤷', wink: '😉',
}

const ZH: Record<string, string> = {
  '微笑': '😊', '撇嘴': '😣', '色': '😍', '发呆': '😳', '得意': '😎', '流泪': '😭',
  '害羞': '😊', '闭嘴': '🤐', '睡': '😴', '大哭': '😢', '尴尬': '😅', '发怒': '😠',
  '调皮': '😜', '呲牙': '😁', '惊讶': '😮', '难过': '🙁', '酷': '😎', '冷汗': '😅',
  '抓狂': '😫', '吐': '🤮', '偷笑': '😄', '愉快': '😄', '白眼': '🙄', '傲慢': '😤',
  '饥饿': '😋', '困': '😪', '惊恐': '😱', '流汗': '😅', '憨笑': '😂', '悠闲': '😎',
  '奋斗': '💪', '咒骂': '🤬', '疑问': '❓', '嘘': '🤫', '晕': '😵', '衰': '😬',
  '骷髅': '💀', '敲打': '🔨', '再见': '👋', '擦汗': '😓', '抠鼻': '👃', '鼓掌': '👏',
  '坏笑': '😜', '左哼哼': '😤', '右哼哼': '😤', '哈欠': '🥱', '鄙视': '😒',
  '委屈': '😞', '快哭了': '😢', '阴险': '😏', '亲亲': '😘', '可怜': '🥺',
  '菜刀': '🔪', '西瓜': '🍉', '啤酒': '🍺', '篮球': '🏀', '乒乓': '🏓',
  '咖啡': '☕', '饭': '🍚', '猪头': '🐷', '玫瑰': '🌹', '凋谢': '🥀', '嘴唇': '💋',
  '爱心': '❤️', '心碎': '💔', '蛋糕': '🎂', '闪电': '⚡', '炸弹': '💣', '刀': '🔪',
  '足球': '⚽', '瓢虫': '🐞', '便便': '💩', '月亮': '🌙', '太阳': '☀️', '礼物': '🎁',
  '拥抱': '🤗', '强': '👍', '弱': '👎', '握手': '🤝', '胜利': '✌️', '抱拳': '🙏',
  '勾引': '👈', '拳头': '✊', 'OK': '👌', 'NO': '🙅', '爱你': '🤟', '爱情': '🥰',
  '飞吻': '😘', '跳跳': '💫', '发抖': '😰', '怄火': '💢', '转圈': '😵', '磕头': '🙇',
  '回头': '🙆', '投降': '🙋', '激动': '🎉', '嘿哈': '😎', '捂脸': '🤦', '奸笑': '😏',
  '机智': '🤓', '皱眉': '😣', '耶': '✌️', '茶': '🍵', '红包': '🧧', '蜡烛': '🕯️',
  '福': '🧧', '鸡': '🐔', '吃瓜': '🍿', '加油': '💪', '加油加油': '💪', '汗': '😅',
  '天啊': '😱', 'Emm': '😐', '社会社会': '🙇', '旺柴': '🐶', '好的': '👌',
  '打脸': '🤦', '哇': '😲', '發': '🤑', '裂开': '💔', '苦涩': '😣', '叹气': '😮‍💨',
  '让我看看': '👀', '666': '👍', '翻白眼': '🙄', '合十': '🙏',
}

function lookup(name: string): string | undefined {
  if (ZH[name]) return ZH[name]
  const key = name.toLowerCase().replace(/！/g, '!').replace(/[!?\s]/g, '')
  return EN[key]
}

export function formatWechatEmoji(text: string): string {
  if (!text) return ''
  return text.replace(/\[([^\]\n]{1,16})\]/g, (raw, name: string) => lookup(name) || raw)
}
