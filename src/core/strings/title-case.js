/** @param {unknown} value @returns {string} */
function titleCase(value) {
  return String(value)
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

module.exports = {
  titleCase,
}
