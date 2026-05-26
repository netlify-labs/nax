const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

function moveCursor({ lines, lineIdx, colIdx }, direction) {
  switch (direction) {
    case 'left':
      if (colIdx > 0) return { lineIdx, colIdx: colIdx - 1 }
      if (lineIdx > 0) return { lineIdx: lineIdx - 1, colIdx: lines[lineIdx - 1].length }
      return { lineIdx, colIdx }
    case 'right':
      if (colIdx < lines[lineIdx].length) return { lineIdx, colIdx: colIdx + 1 }
      if (lineIdx < lines.length - 1) return { lineIdx: lineIdx + 1, colIdx: 0 }
      return { lineIdx, colIdx }
    case 'up': {
      if (lineIdx === 0) return { lineIdx, colIdx }
      const next = lineIdx - 1
      return { lineIdx: next, colIdx: Math.min(colIdx, lines[next].length) }
    }
    case 'down': {
      if (lineIdx >= lines.length - 1) return { lineIdx, colIdx }
      const next = lineIdx + 1
      return { lineIdx: next, colIdx: Math.min(colIdx, lines[next].length) }
    }
    case 'home':
      return { lineIdx, colIdx: 0 }
    case 'end':
      return { lineIdx, colIdx: lines[lineIdx].length }
    default:
      return { lineIdx, colIdx }
  }
}

function multiline({ message, placeholder = '', initialValue = '' }) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY || !process.stdin.setRawMode) {
      resolve(initialValue)
      return
    }

    const lines = initialValue ? initialValue.split('\n') : ['']
    let lineIdx = lines.length - 1
    let colIdx = lines[lineIdx].length
    let isPasting = false

    console.log(`\x1b[36m?\x1b[0m \x1b[1m${message}\x1b[0m \x1b[2m(Shift+Enter: newline, Enter: submit)\x1b[0m`)
    if (placeholder && !initialValue) console.log(`\x1b[2m${placeholder}\x1b[0m`)
    if (initialValue) process.stdout.write(lines.join('\n'))

    process.stdout.write('\x1b[?2004h\x1b[>1u')
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding('utf8')

    const cleanup = () => {
      process.stdout.write('\x1b[?2004l\x1b[<u')
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stdin.removeListener('data', onData)
    }

    const insertNewline = () => {
      lines.splice(lineIdx + 1, 0, '')
      lineIdx++
      colIdx = 0
      process.stdout.write('\n')
    }

    const applyMove = (direction) => {
      const prevLine = lineIdx
      const next = moveCursor({ lines, lineIdx, colIdx }, direction)
      if (next.lineIdx === lineIdx && next.colIdx === colIdx) return
      lineIdx = next.lineIdx
      colIdx = next.colIdx
      const rowDelta = lineIdx - prevLine
      if (rowDelta < 0) process.stdout.write(`\x1b[${-rowDelta}A`)
      else if (rowDelta > 0) process.stdout.write(`\x1b[${rowDelta}B`)
      process.stdout.write(`\x1b[${colIdx + 1}G`)
    }

    const onData = (chunk) => {
      let data = chunk
      if (data.includes(PASTE_START)) {
        isPasting = true
        data = data.split(PASTE_START).join('')
      }

      let pasteEnded = false
      if (data.includes(PASTE_END)) {
        pasteEnded = true
        data = data.split(PASTE_END).join('')
      }

      for (let i = 0; i < data.length; i++) {
        const ch = data[i]

        if (ch === '\x03') {
          cleanup()
          console.log('\n\x1b[31m✖\x1b[0m Cancelled')
          process.exit(0)
        }

        if (ch === '\x1b' && data[i + 1] === '[') {
          const kittyMatch = /^\x1b\[(\d+)(?:;(\d+))?u/.exec(data.slice(i))
          if (kittyMatch) {
            const keyCode = Number(kittyMatch[1])
            const modifier = kittyMatch[2] ? Number(kittyMatch[2]) : 1

            if (modifier === 5 && keyCode === 99) {
              cleanup()
              console.log('\n\x1b[31m✖\x1b[0m Cancelled')
              process.exit(0)
            }
            if (modifier === 2 && keyCode === 13) {
              insertNewline()
            }

            i += kittyMatch[0].length - 1
            continue
          }

          const csiMatch = /^\x1b\[(\d+(?:;\d+)*)?([a-zA-Z~])/.exec(data.slice(i))
          if (csiMatch) {
            const params = csiMatch[1] || ''
            const final = csiMatch[2]
            if (final === 'A') applyMove('up')
            else if (final === 'B') applyMove('down')
            else if (final === 'C') applyMove('right')
            else if (final === 'D') applyMove('left')
            else if (final === 'H' || (final === '~' && params === '1')) applyMove('home')
            else if (final === 'F' || (final === '~' && params === '4')) applyMove('end')
            i += csiMatch[0].length - 1
            continue
          }
        }

        if (ch === '\r' || ch === '\n') {
          if (ch === '\n' && i > 0 && data[i - 1] === '\r') continue
          if (isPasting) {
            insertNewline()
          } else {
            cleanup()
            console.log()
            resolve(lines.join('\n'))
            return
          }
          continue
        }

        if (ch === '\x7f') {
          if (colIdx > 0) {
            lines[lineIdx] = lines[lineIdx].slice(0, colIdx - 1) + lines[lineIdx].slice(colIdx)
            colIdx--
            process.stdout.write('\b \b')
          } else if (lineIdx > 0) {
            const prev = lines[lineIdx - 1]
            lines[lineIdx - 1] = prev + lines[lineIdx]
            lines.splice(lineIdx, 1)
            lineIdx--
            colIdx = prev.length
            process.stdout.write(`\x1b[A\x1b[${colIdx + 1}G\x1b[J${lines[lineIdx].slice(colIdx)}`)
          }
          continue
        }

        if (ch === '\x1b') {
          if (i + 1 < data.length && data[i + 1] === '[') {
            i += 2
            while (i < data.length && ((data[i] >= '0' && data[i] <= '9') || data[i] === ';')) i++
          }
          continue
        }

        lines[lineIdx] = lines[lineIdx].slice(0, colIdx) + ch + lines[lineIdx].slice(colIdx)
        colIdx++
        const tail = lines[lineIdx].slice(colIdx)
        if (tail) {
          process.stdout.write(`${ch}${tail}\x1b[${tail.length}D`)
        } else {
          process.stdout.write(ch)
        }
      }

      if (pasteEnded) isPasting = false
    }

    process.stdin.on('data', onData)
  })
}

module.exports = { multiline, moveCursor }
