/**
 * Checks which variables are set. Only names are returned.
 * @param {string[]} names
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ present: string[], missing: string[] }}
 */
function checkSecrets(names, env = process.env) {
  const present = []
  const missing = []
  for (const name of [...new Set(names)]) {
    if (env[name]) present.push(name)
    else missing.push(name)
  }
  return { present, missing }
}

module.exports = { checkSecrets }
