const path = require('node:path')
const { createRequire } = require('node:module')

const FFMPEG_STATIC = '5.3.0'
const FFPROBE_INSTALLER = '2.1.2'

/** @type {import('./index').ToolRecipe} */
const ffmpeg = {
  name: 'ffmpeg',
  version: `${FFMPEG_STATIC}+${FFPROBE_INSTALLER}`,
  provides: ['ffmpeg', 'ffprobe'],
  async install({ installDir, npmInstall }) {
    npmInstall(installDir, [`ffmpeg-static@${FFMPEG_STATIC}`, `@ffprobe-installer/ffprobe@${FFPROBE_INSTALLER}`])
    const requireFromTools = createRequire(path.join(installDir, 'node_modules', 'noop.js'))
    return {
      ffmpeg: /** @type {string} */ (requireFromTools('ffmpeg-static')),
      ffprobe: /** @type {{ path: string }} */ (requireFromTools('@ffprobe-installer/ffprobe')).path,
    }
  },
}

module.exports = { ffmpeg }
