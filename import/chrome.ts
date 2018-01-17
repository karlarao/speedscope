import {Profile, TimeFormatter, FrameInfo} from '../profile'
import {getOrInsert} from '../utils'

interface TimelineEvent {
  pid: number,
  tid: number,
  ts: number,
  ph: string,
  cat: string,
  name: string,
  dur: number,
  tdur: number,
  tts: number,
  args: { [key: string]: any }
}

interface PositionTickInfo {
  line: number,
  ticks: number
}

interface CPUProfileCallFrame {
  columnNumber: number,
  functionName: string,
  lineNumber: number,
  scriptId: string,
  url: string
}

interface CPUProfileNode {
  callFrame: CPUProfileCallFrame
  hitCount: number
  id: number
  children?: number[]
  positionTicks?: PositionTickInfo[]
  parent?: CPUProfileNode
}

interface CPUProfile {
  startTime: number,
  endTime: number,
  nodes: CPUProfileNode[],
  samples: number[],
  timeDeltas: number[]
}

export function importFromChromeTimeline(events: TimelineEvent[]) {
  const profileEvent = events[events.length - 1]
  const chromeProfile = profileEvent.args.data.cpuProfile as CPUProfile
  return importFromChromeCPUProfile(chromeProfile)
}

export function importFromChromeCPUProfile(chromeProfile: CPUProfile) {
  const profile = new Profile(chromeProfile.endTime - chromeProfile.startTime)

  const nodeById = new Map<number, CPUProfileNode>()
  for (let node of chromeProfile.nodes) {
    nodeById.set(node.id, node)
  }
  for (let node of chromeProfile.nodes) {
    if (!node.children) continue
    for (let childId of node.children) {
      const child = nodeById.get(childId)
      if (!child) continue
      child.parent = node
    }
  }

  const samples: number[] = []
  const timeDeltas: number[] = []

  let elapsed = 0
  let lastNodeId = NaN

  // The chrome CPU profile format doesn't collapse identical samples. We'll do that
  // here to save a ton of work later doing mergers.
  for (let i = 0; i < chromeProfile.samples.length; i++) {
    const nodeId = chromeProfile.samples[i]
    if (nodeId != lastNodeId) {
      samples.push(nodeId)
      timeDeltas.push(elapsed)
      elapsed = 0
    }

    elapsed += chromeProfile.timeDeltas[i]
    lastNodeId = nodeId
  }
  if (!isNaN(lastNodeId)) {
    samples.push(lastNodeId)
    timeDeltas.push(elapsed)
  }

  const callFrameToFrameInfo = new Map<CPUProfileCallFrame, FrameInfo>()

  let lastNonGCStackTop: CPUProfileNode | null = null
  for (let i = 0; i < samples.length; i++) {
    const timeDelta = timeDeltas[i+1] || 0
    const nodeId = samples[i]
    let node = nodeById.get(nodeId)
    if (!node) continue

    const stack: FrameInfo[] = []

    if (node.callFrame.functionName === "(garbage collector)") {
      // Place GC calls on top of the previous call stack
      const frame = getOrInsert(callFrameToFrameInfo, node.callFrame, (callFrame) => ({
        key: callFrame.functionName,
        name: callFrame.functionName,
        file: callFrame.url,
        line: callFrame.lineNumber,
        col: callFrame.columnNumber
      }))
      stack.push(frame)
      if (!lastNonGCStackTop) {
        profile.appendSample(stack, timeDelta)
        continue
      } else {
        node = lastNonGCStackTop
      }
    }

    lastNonGCStackTop = node

    // TODO(jlfwong): This is silly and slow, but good enough for now
    for (; node; node = node.parent) {
      if (node.callFrame.functionName === '(root)') continue
      if (node.callFrame.functionName === '(idle)') continue

      const frame = getOrInsert(callFrameToFrameInfo, node.callFrame, (callFrame) => {
        const name = callFrame.functionName || "(anonymous)"
        const file = callFrame.url
        const line = callFrame.lineNumber
        const col = callFrame.columnNumber
        return {
          key: `${name}:${file}:${line}:${col}`,
          name,
          file,
          line,
          col
        }
      })
      stack.push(frame)
    }
    stack.reverse()

    profile.appendSample(stack, timeDelta)
  }

  profile.setValueFormatter(new TimeFormatter('microseconds'))
  return profile
}