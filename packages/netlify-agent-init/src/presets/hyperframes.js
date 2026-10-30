/** The skills the hyperframes npm package ships in dist/skills. hyperframes-registry is only on GitHub. */
const HYPERFRAMES_SKILLS = ['hyperframes', 'hyperframes-cli', 'media-use']

/**
 * HyperFrames: static FFmpeg, the skills the npm package ships at the pinned
 * version, and the headless Chrome HyperFrames renders with.
 * @param {{ version?: string, dir?: string }} options
 * @returns {import('../config').PresetResult}
 */
function hyperframesPreset(options = {}) {
  const version = options.version
  if (!version) throw new Error('preset "hyperframes" needs a "version", for example "0.8.217"')
  const dir = options.dir || '.'
  return {
    tools: [{ name: 'ffmpeg', link: [] }],
    skills: [{ from: `npm:hyperframes@${version}`, path: 'dist/skills', names: HYPERFRAMES_SKILLS }],
    run: [{ cwd: dir, command: `npx -y hyperframes@${version} browser ensure` }],
    agentsMd: [
      `- To edit or render the HyperFrames video, read the \`hyperframes\` skill first and follow its work loop. Run \`npx hyperframes\` commands from \`${dir}\`.`,
      '- FFmpeg, FFprobe and HyperFrames\' Chrome are installed during setup. Check with `npx hyperframes doctor --json`. Never try `apt-get`; there is no root.',
    ],
  }
}

module.exports = {
  HYPERFRAMES_SKILLS,
  hyperframesPreset,
}
