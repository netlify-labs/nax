// Interactive stepper visualization of the nax council pattern: independent
// fan-out, step gating, cross-review, consensus synthesis, and artifacts.
'use client'

import { useEffect, useState } from 'react'
import type { KeyboardEvent } from 'react'

type Agent = {
  key: string
  name: string
  color: string
  firstMs: number
  crossMs: number
}

const AGENTS: Agent[] = [
  { key: 'claude', name: 'Claude', color: '#d97757', firstMs: 2600, crossMs: 2000 },
  { key: 'gemini', name: 'Gemini', color: '#4c8bf5', firstMs: 1500, crossMs: 1200 },
  { key: 'codex', name: 'Codex', color: '#10a37f', firstMs: 3200, crossMs: 2400 }
]

const VIOLET = '#a78bfa'
const AMBER = '#fbbf24'
const EMERALD = '#34d399'
const TEXT = '#e2e8f0'
const MUTED = '#94a3b8'
const CARD_BG = '#111a2b'
const CARD_STROKE = '#273248'

const PHASES = [
  {
    title: 'The flow file',
    caption:
      'A workflow is a flow config plus Markdown prompts — diffable, reviewable, repeatable. This flow has three steps; nax runs them in order.'
  },
  {
    title: 'Independent first pass',
    caption:
      'Step 1 fans the same prompt out to every selected model in parallel. No agent sees another’s answer — independent judgment comes first.'
  },
  {
    title: 'Step gate',
    caption:
      'Gemini finished early, but the run holds at the gate until the slowest agent lands. Every agent’s findings are saved before round 2 starts.'
  },
  {
    title: 'Cross-review',
    caption:
      'Step 2 feeds each agent the other agents’ findings. They confirm, reject, or challenge specific claims — with evidence.'
  },
  {
    title: 'Synthesize',
    caption:
      'Step 3 hands everything to one agent to merge into a consensus: agreements, disagreements worth reading, and unsupported claims filtered out.'
  },
  {
    title: 'Artifacts & handoff',
    caption:
      'Every step landed under .nax/ as durable artifacts. A human owns the final call — nax handoff -c copies the consensus to your clipboard.'
  }
]

const PHASE_HOLD_MS = [2400, 4000, 2600, 3200, 2600, 0]

// Flow-file step index highlighted during each phase (null = none)
const FLOW_STEP_FOR_PHASE: Array<number | null> = [null, 0, 0, 1, 2, null]

const AGENT_Y = [95, 225, 355]
const AGENT_X = 220
const AGENT_W = 170
const AGENT_H = 80
const GATE_X = 428

type ArrowProps = {
  d: string
  color: string
  animate: boolean
  opacity?: number
  marker?: string
}

function Arrow({ d, color, animate, opacity = 1, marker }: ArrowProps) {
  return (
    <path
      d={d}
      pathLength={1}
      className={animate ? 'nax-viz-draw-anim' : undefined}
      fill="none"
      stroke={color}
      strokeWidth={1.75}
      opacity={opacity}
      markerEnd={marker}
    />
  )
}

export function CouncilViz() {
  const [phase, setPhase] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [done, setDone] = useState([false, false, false])
  const [reduced, setReduced] = useState(false)

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduced(mq.matches)
    const onChange = () => setReduced(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    if (phase !== 1 && phase !== 3) return
    if (reduced) {
      setDone([true, true, true])
      return
    }
    setDone([false, false, false])
    const timers = AGENTS.map((agent, i) =>
      setTimeout(() => {
        setDone(prev => prev.map((d, j) => (j === i ? true : d)))
      }, phase === 1 ? agent.firstMs : agent.crossMs)
    )
    return () => timers.forEach(clearTimeout)
  }, [phase, reduced])

  useEffect(() => {
    if (!playing) return
    if (phase >= PHASES.length - 1) {
      setPlaying(false)
      return
    }
    const holdMs = reduced ? 1800 : PHASE_HOLD_MS[phase]
    const timer = setTimeout(() => setPhase(p => p + 1), holdMs)
    return () => clearTimeout(timer)
  }, [playing, phase, reduced])

  const isLast = phase === PHASES.length - 1
  const agentDone = (i: number) => (phase === 1 || phase === 3 ? done[i] : phase >= 2)
  const gateOpen = phase >= 2 || (phase === 1 && done.every(Boolean))

  const goTo = (p: number) => {
    setPlaying(false)
    setPhase(Math.max(0, Math.min(PHASES.length - 1, p)))
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      goTo(phase + 1)
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      goTo(phase - 1)
    }
  }

  const togglePlay = () => {
    if (isLast && !playing) setPhase(0)
    setPlaying(prev => !prev)
  }

  return (
    <div
      className="nax-viz"
      role="group"
      aria-label="Interactive walkthrough of the nax council pattern"
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <div className="nax-viz-controls">
        <button
          type="button"
          className="nax-viz-btn"
          onClick={() => goTo(phase - 1)}
          disabled={phase === 0}
          aria-label="Previous step"
        >
          ←
        </button>
        <button
          type="button"
          className="nax-viz-btn nax-viz-btn-play"
          onClick={togglePlay}
          aria-label={playing ? 'Pause walkthrough' : 'Play walkthrough'}
        >
          {playing ? '❚❚' : '▶'}
        </button>
        <button
          type="button"
          className="nax-viz-btn"
          onClick={() => goTo(phase + 1)}
          disabled={isLast}
          aria-label="Next step"
        >
          →
        </button>
        <div className="nax-viz-dots" role="tablist" aria-label="Walkthrough steps">
          {PHASES.map((p, i) => (
            <button
              key={p.title}
              type="button"
              role="tab"
              aria-selected={i === phase}
              aria-label={`Step ${i + 1}: ${p.title}`}
              className={i === phase ? 'nax-viz-dot nax-viz-dot-active' : 'nax-viz-dot'}
              onClick={() => goTo(i)}
            />
          ))}
        </div>
        <span className="nax-viz-phase-title">
          {phase + 1}/{PHASES.length} · {PHASES[phase].title}
        </span>
      </div>

      <svg
        className="nax-viz-stage"
        viewBox="0 0 760 460"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <marker id="nax-viz-arrow-slate" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 8 4 L 0 8 z" fill={MUTED} />
          </marker>
          {AGENTS.map(agent => (
            <marker
              key={agent.key}
              id={`nax-viz-arrow-${agent.key}`}
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 8 4 L 0 8 z" fill={agent.color} />
            </marker>
          ))}
          <marker id="nax-viz-arrow-violet" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 8 4 L 0 8 z" fill={VIOLET} />
          </marker>
        </defs>

        {/* Flow file */}
        <g opacity={phase === 0 ? 1 : 0.55}>
          <rect x={18} y={150} width={142} height={150} rx={10} fill={CARD_BG} stroke={phase === 0 ? VIOLET : CARD_STROKE} strokeWidth={phase === 0 ? 1.5 : 1} />
          <text x={32} y={175} fontSize={12} fontWeight={600} fill={TEXT} fontFamily="var(--nax-viz-mono)">
            flow.yaml
          </text>
          <text x={32} y={193} fontSize={10} fill={MUTED} fontFamily="var(--nax-viz-mono)">
            + prompts/*.md
          </text>
          {['1. review', '2. cross-review', '3. synthesize'].map((label, i) => {
            const active = FLOW_STEP_FOR_PHASE[phase] === i
            return (
              <g key={label}>
                <rect x={28} y={204 + i * 28} width={122} height={22} rx={5} fill={active ? '#1c2a44' : 'transparent'} stroke={active ? VIOLET : 'transparent'} strokeWidth={1} />
                <text x={36} y={219 + i * 28} fontSize={11} fill={active ? TEXT : MUTED} fontFamily="var(--nax-viz-mono)">
                  {label}
                </text>
              </g>
            )
          })}
        </g>

        {/* Fan-out arrows: flow file -> agents */}
        {phase >= 1 && (
          <g opacity={phase === 1 ? 1 : 0.3}>
            <Arrow d={`M 160 200 C 195 190, 190 95, ${AGENT_X - 5} 95`} color={MUTED} animate={phase === 1} marker="url(#nax-viz-arrow-slate)" />
            <Arrow d={`M 160 225 L ${AGENT_X - 5} 225`} color={MUTED} animate={phase === 1} marker="url(#nax-viz-arrow-slate)" />
            <Arrow d={`M 160 250 C 195 260, 190 355, ${AGENT_X - 5} 355`} color={MUTED} animate={phase === 1} marker="url(#nax-viz-arrow-slate)" />
          </g>
        )}

        {/* Agents */}
        {AGENTS.map((agent, i) => {
          const y = AGENT_Y[i] - AGENT_H / 2
          const isRunning = (phase === 1 || phase === 3) && !done[i]
          const finished = agentDone(i)
          const dimmed = phase === 0 || phase >= 4
          const barColor = phase >= 3 ? VIOLET : agent.color
          const barMs = phase === 3 ? agent.crossMs : agent.firstMs
          const barAnimating = (phase === 1 || phase === 3) && !reduced
          const barVisible = phase >= 1
          const status = isRunning
            ? phase === 3 ? 'cross-reviewing…' : 'reviewing…'
            : phase === 0
              ? 'idle'
              : phase >= 3
                ? 'notes.md ✓'
                : 'findings.md ✓'
          return (
            <g key={agent.key} opacity={dimmed ? 0.45 : 1}>
              <rect x={AGENT_X} y={y} width={AGENT_W} height={AGENT_H} rx={10} fill={CARD_BG} stroke={isRunning ? agent.color : CARD_STROKE} strokeWidth={isRunning ? 1.5 : 1} />
              <circle cx={AGENT_X + 18} cy={y + 20} r={5} fill={agent.color} />
              <text x={AGENT_X + 30} y={y + 24} fontSize={12.5} fontWeight={600} fill={TEXT} fontFamily="var(--nax-viz-sans)">
                {agent.name}
              </text>
              {barVisible && (
                <g>
                  <rect x={AGENT_X + 14} y={y + 36} width={AGENT_W - 28} height={7} rx={3.5} fill="#0b1220" />
                  <rect
                    key={`bar-${phase}-${agent.key}`}
                    x={AGENT_X + 14}
                    y={y + 36}
                    width={AGENT_W - 28}
                    height={7}
                    rx={3.5}
                    fill={barColor}
                    className={barAnimating ? 'nax-viz-bar nax-viz-bar-anim' : 'nax-viz-bar'}
                    style={barAnimating ? { animationDuration: `${barMs}ms` } : undefined}
                  />
                </g>
              )}
              <text x={AGENT_X + 14} y={y + 64} fontSize={10.5} fill={finished && phase >= 1 ? EMERALD : MUTED} fontFamily="var(--nax-viz-mono)">
                {status}
              </text>
              {isRunning && <circle cx={AGENT_X + AGENT_W - 18} cy={y + 60} r={4} fill={agent.color} className="nax-viz-pulse" />}
              {finished && phase >= 1 && (
                <text x={AGENT_X + AGENT_W - 24} y={y + 64} fontSize={11} fill={EMERALD} fontFamily="var(--nax-viz-sans)">
                  ✓
                </text>
              )}
              {/* Cross-review inputs: the other agents' findings */}
              {phase === 3 && (
                <g className={reduced ? undefined : 'nax-viz-pop'}>
                  {AGENTS.filter((_, j) => j !== i).map((other, k) => (
                    <circle key={other.key} cx={AGENT_X + AGENT_W - 40 + k * 12} cy={y + 20} r={4.5} fill={other.color} stroke="#0b1220" strokeWidth={1} />
                  ))}
                  <text x={AGENT_X + AGENT_W - 46} y={y + 20 + 3.5} fontSize={10} fill={MUTED} textAnchor="end" fontFamily="var(--nax-viz-sans)">
                    reads
                  </text>
                </g>
              )}
            </g>
          )
        })}

        {/* Step gate */}
        {(phase === 1 || phase === 2) && (
          <g>
            <line x1={GATE_X} y1={50} x2={GATE_X} y2={410} stroke={gateOpen ? EMERALD : AMBER} strokeWidth={1.5} strokeDasharray={gateOpen ? 'none' : '5 5'} opacity={gateOpen ? 0.7 : 0.9} />
            <rect x={GATE_X - 62} y={22} width={124} height={20} rx={10} fill={CARD_BG} stroke={gateOpen ? EMERALD : AMBER} strokeWidth={1} />
            <text x={GATE_X} y={36} fontSize={10.5} fill={gateOpen ? EMERALD : AMBER} textAnchor="middle" fontFamily="var(--nax-viz-sans)">
              {gateOpen ? 'gate open — all done' : 'gate: waiting for all'}
            </text>
          </g>
        )}

        {/* Findings passing through the open gate into round 2 */}
        {phase === 2 && (
          <g className={reduced ? undefined : 'nax-viz-pop'}>
            {AGENTS.map((agent, i) => (
              <g key={agent.key}>
                <path d={`M 395 ${AGENT_Y[i]} L 448 ${AGENT_Y[i]}`} fill="none" stroke={agent.color} strokeWidth={1.5} opacity={0.6} markerEnd={`url(#nax-viz-arrow-${agent.key})`} />
                <rect x={454} y={AGENT_Y[i] - 12} width={104} height={24} rx={6} fill={CARD_BG} stroke={agent.color} strokeWidth={1} />
                <circle cx={466} cy={AGENT_Y[i]} r={3.5} fill={agent.color} />
                <text x={475} y={AGENT_Y[i] + 3.5} fontSize={10} fill={TEXT} fontFamily="var(--nax-viz-mono)">
                  findings.md
                </text>
              </g>
            ))}
            <text x={506} y={425} fontSize={10.5} fill={MUTED} textAnchor="middle" fontFamily="var(--nax-viz-sans)">
              saved to .nax/ → input for round 2
            </text>
          </g>
        )}

        {/* Cross-review arrows between agents */}
        {phase === 3 && (
          <g>
            <Arrow d="M 395 105 C 450 130, 450 190, 397 215" color={AGENTS[0].color} animate={!reduced} marker="url(#nax-viz-arrow-claude)" />
            <Arrow d="M 395 235 C 450 260, 450 320, 397 345" color={AGENTS[1].color} animate={!reduced} marker="url(#nax-viz-arrow-gemini)" />
            <Arrow d="M 395 345 C 480 300, 480 145, 397 100" color={AGENTS[2].color} animate={!reduced} marker="url(#nax-viz-arrow-codex)" />
            <Arrow d="M 215 215 C 165 190, 165 130, 213 105" color={AGENTS[1].color} animate={!reduced} opacity={0.55} marker="url(#nax-viz-arrow-gemini)" />
            <Arrow d="M 215 345 C 165 320, 165 260, 213 235" color={AGENTS[2].color} animate={!reduced} opacity={0.55} marker="url(#nax-viz-arrow-codex)" />
            <Arrow d="M 213 100 C 135 145, 135 300, 215 345" color={AGENTS[0].color} animate={!reduced} opacity={0.55} marker="url(#nax-viz-arrow-claude)" />
          </g>
        )}

        {/* Agents -> consensus */}
        {phase >= 4 && (
          <g opacity={phase === 4 ? 1 : 0.4}>
            <Arrow d="M 395 95 C 440 100, 440 195, 466 205" color={VIOLET} animate={phase === 4 && !reduced} marker="url(#nax-viz-arrow-violet)" />
            <Arrow d="M 395 225 L 466 225" color={VIOLET} animate={phase === 4 && !reduced} marker="url(#nax-viz-arrow-violet)" />
            <Arrow d="M 395 355 C 440 350, 440 255, 466 245" color={VIOLET} animate={phase === 4 && !reduced} marker="url(#nax-viz-arrow-violet)" />
          </g>
        )}

        {/* Consensus */}
        {phase >= 4 && (
          <g className={phase === 4 && !reduced ? 'nax-viz-pop' : undefined} opacity={phase === 4 ? 1 : 0.6}>
            <rect x={472} y={165} width={140} height={120} rx={10} fill={CARD_BG} stroke={VIOLET} strokeWidth={1.5} />
            <text x={486} y={190} fontSize={12} fontWeight={600} fill={TEXT} fontFamily="var(--nax-viz-sans)">
              Consensus
            </text>
            <text x={486} y={208} fontSize={10} fill={MUTED} fontFamily="var(--nax-viz-mono)">
              summary.md
            </text>
            {[
              { label: 'agreed findings', color: EMERALD },
              { label: 'open disagreements', color: AMBER },
              { label: 'unsupported: dropped', color: MUTED }
            ].map((row, i) => (
              <g key={row.label}>
                <circle cx={492} cy={224 + i * 18} r={3} fill={row.color} />
                <text x={502} y={228 + i * 18} fontSize={10} fill={row.color} fontFamily="var(--nax-viz-sans)">
                  {row.label}
                </text>
              </g>
            ))}
          </g>
        )}

        {/* Consensus -> artifacts + human */}
        {phase === 5 && (
          <g>
            <Arrow d="M 614 205 C 632 195, 630 150, 642 145" color={MUTED} animate={!reduced} marker="url(#nax-viz-arrow-slate)" />
            <Arrow d="M 614 245 C 632 255, 630 300, 642 305" color={MUTED} animate={!reduced} marker="url(#nax-viz-arrow-slate)" />
          </g>
        )}

        {/* Artifacts */}
        {phase === 5 && (
          <g className={reduced ? undefined : 'nax-viz-pop'}>
            <rect x={646} y={95} width={100} height={100} rx={10} fill={CARD_BG} stroke={EMERALD} strokeWidth={1} />
            <text x={658} y={118} fontSize={11.5} fontWeight={600} fill={EMERALD} fontFamily="var(--nax-viz-mono)">
              .nax/
            </text>
            {['workflow/', 'runners/', 'latest →'].map((line, i) => (
              <text key={line} x={658} y={138 + i * 17} fontSize={10} fill={MUTED} fontFamily="var(--nax-viz-mono)">
                {line}
              </text>
            ))}
          </g>
        )}

        {/* Human review */}
        {phase === 5 && (
          <g className={reduced ? undefined : 'nax-viz-pop'}>
            <rect x={646} y={260} width={100} height={90} rx={10} fill={CARD_BG} stroke={TEXT} strokeWidth={1} />
            <circle cx={670} cy={287} r={7} fill="none" stroke={TEXT} strokeWidth={1.5} />
            <path d="M 659 306 C 661 297, 679 297, 681 306" fill="none" stroke={TEXT} strokeWidth={1.5} />
            <text x={692} y={295} fontSize={11} fontWeight={600} fill={TEXT} fontFamily="var(--nax-viz-sans)">
              you
            </text>
            <text x={658} y={330} fontSize={9.5} fill={MUTED} fontFamily="var(--nax-viz-mono)">
              handoff -c
            </text>
          </g>
        )}
      </svg>

      <p className="nax-viz-caption" aria-live="polite">
        {PHASES[phase].caption}
      </p>
    </div>
  )
}
