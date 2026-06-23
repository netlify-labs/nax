const fs = require('fs')
const path = require('path')

const { requestError } = require('../api/errors')

/**
 * @param {string} parentDir
 * @param {string} targetPath
 */
function isInsideDir(parentDir, targetPath) {
  const relative = path.relative(parentDir, targetPath)
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative))
}

/**
 * @param {unknown} filePath
 * @param {{
 *   projectRoot: string,
 *   openModule?: ((filePath: string) => Promise<unknown> | unknown) | null,
 * }} input
 */
async function openLocalFile(filePath, { projectRoot, openModule = null }) {
  const absoluteFilePath = path.resolve(String(filePath || ''))
  const absoluteProjectRoot = path.resolve(projectRoot)
  if (!isInsideDir(absoluteProjectRoot, absoluteFilePath)) {
    throw requestError(403, 'forbidden_path', 'Only paths under the current project root can be opened.')
  }
  let realProjectRoot
  let realFilePath
  try {
    realProjectRoot = fs.realpathSync(absoluteProjectRoot)
    realFilePath = fs.realpathSync(absoluteFilePath)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw requestError(404, 'path_not_found', 'Path not found.')
    }
    throw error
  }
  if (!isInsideDir(realProjectRoot, realFilePath)) {
    throw requestError(403, 'forbidden_path', 'Only paths under the current project root can be opened.')
  }
  if (!fs.existsSync(realFilePath)) {
    throw requestError(404, 'path_not_found', 'Path not found.')
  }
  const stat = fs.statSync(realFilePath)
  if (!stat.isFile() && !stat.isDirectory()) {
    throw requestError(400, 'unsupported_path', 'Path is not a file or directory.')
  }
  const opener = openModule || (await import('open')).default
  await opener(realFilePath)
  return realFilePath
}

module.exports = {
  isInsideDir,
  openLocalFile,
}
