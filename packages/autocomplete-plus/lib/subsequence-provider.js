const { CompositeDisposable, TextBuffer } = require('atom')
const ProviderConfig = require('./provider-config')

module.exports =
class SubsequenceProvider {
  constructor (options = {}) {
    this.defaults()

    this.subscriptions = new CompositeDisposable()
    this.watchedBuffers = new Map()

    if (options.atomConfig) {
      this.atomConfig = options.atomConfig
    }

    if (options.atomWorkspace) {
      this.atomWorkspace = options.atomWorkspace
    }

    this.providerConfig = new ProviderConfig({
      atomConfig: this.atomConfig
    })

    // make this.X available where X is the autocomplete-plus.X setting
    const settings = [
      'autocomplete-plus.enableExtendedUnicodeSupport', // TODO
      'autocomplete-plus.minimumWordLength',
      'autocomplete-plus.includeCompletionsFromAllBuffers',
      'autocomplete-plus.useLocalityBonus',
      'autocomplete-plus.strictMatching'
    ]
    settings.forEach(property => {
      this.subscriptions.add(this.atomConfig.observe(property, val => {
        this[property.split('.')[1]] = val
      }))
    })

    this.subscriptions.add(this.atomWorkspace.observeTextEditors((e) => {
      this.watchBuffer(e)
    }))

    this.configSuggestionsBuffer = new TextBuffer()
  }

  defaults () {
    this.atomConfig = atom.config
    this.atomWorkspace = atom.workspace

    this.possibileWordCharacters = '/\\()"\':,.;<>~!@#$%^&*|+=[]{}`?_-…'.split('')
    this.enableExtendedUnicodeSupport = false
    this.maxSuggestions = 20
    this.maxResultsPerBuffer = 20
    this.maxSearchRowDelta = 3000

    this.labels = ['workspace-center', 'default', 'subsequence-provider']
    this.scopeSelector = '*'
    this.inclusionPriority = 0
    this.suggestionPriority = 0

    this.watchedBuffers = null
  }

  dispose () {
    return this.subscriptions.dispose()
  }

  getAdditionalWordCharacters (scopeDescriptor) {
    const nonWordCharacters = this.atomConfig.get('editor.nonWordCharacters', {scope: scopeDescriptor})

    let additionalWordCharacters = ''

    this.possibileWordCharacters.forEach(character => {
      if (!nonWordCharacters.includes(character)) {
        additionalWordCharacters += character
      }
    })

    return additionalWordCharacters
  }

  watchBuffer (editor) {
    const buffer = editor.getBuffer()

    if (!this.watchedBuffers.has(buffer)) {
      const bufferSubscriptions = new CompositeDisposable()
      bufferSubscriptions.add(buffer.onDidDestroy(() => {
        bufferSubscriptions.dispose()
        this.watchedBuffers.delete(buffer)
      }))
    }

    this.watchedBuffers.set(buffer, editor)
  }

  // This is kind of a hack. We throw the config suggestions in a buffer, so
  // we can use .findWordsWithSubsequence on them.
  configSuggestionsToSubsequenceMatches (suggestions, prefix) {
    if (!suggestions || suggestions.length === 0) {
      return Promise.resolve([])
    }

    const suggestionText = suggestions
      .map(sug => sug.displayText || sug.snippet || sug.text)
      .join('\n')

    this.configSuggestionsBuffer.buffer.setText(suggestionText)

    return this.configSuggestionsBuffer.findWordsWithSubsequence(
      prefix,
      '(){}[] :;,$@%',
      this.maxResultsPerBuffer
    ).then(matches => {
      for (let k = 0; k < matches.length; k++) {
        matches[k].configSuggestion = suggestions[matches[k].positions[0].row]
      }
      return matches
    })
  }

  clampedRange (maxDelta, cursorRow, maxRow) {
    const clampedMinRow = Math.max(0, cursorRow - maxDelta)
    const clampedMaxRow = Math.min(maxRow, cursorRow + maxDelta)
    const actualMinRowDelta = cursorRow - clampedMinRow
    const actualMaxRowDelta = clampedMaxRow - cursorRow

    return {
      start: {
        row: clampedMinRow - maxDelta + actualMaxRowDelta,
        column: 0
      },
      end: {
        row: clampedMaxRow + maxDelta - actualMinRowDelta,
        column: 0
      }
    }
  }

  bufferToSubsequenceMatches (prefix, additionalWordCharacters, buffer) {
    const position = this.watchedBuffers.get(buffer).getCursorBufferPosition()
    const searchRange = this.clampedRange(
      this.maxSearchRowDelta,
      position.row,
      buffer.getEndPosition().row
    )
    return buffer.findWordsWithSubsequenceInRange(
      prefix,
      additionalWordCharacters,
      this.maxResultsPerBuffer,
      searchRange
    )
  }

  /*
  Section: Suggesting Completions
  */

  getSuggestions ({editor, bufferPosition, prefix, scopeDescriptor}) {
    if (!prefix) {
      return
    }

    if (prefix.trim().length < this.minimumWordLength) {
      return
    }

    const buffers = this.includeCompletionsFromAllBuffers
      ? Array.from(this.watchedBuffers.keys())
      : [editor.getBuffer()]

    const currentEditorBuffer = editor.getBuffer()

    const lastCursorRow = editor.getLastCursor().getBufferPosition().row

    const additionalWordCharacters = this.getAdditionalWordCharacters(scopeDescriptor)

    const configSuggestions = this.providerConfig.getSuggestionsForScopeDescriptor(
      scopeDescriptor
    )

    const configMatches = this.configSuggestionsToSubsequenceMatches(
      configSuggestions,
      prefix
    )

    const wordsUnderCursors = editor.getCursors().reduce((words, cursor) => {
      const word = editor.getBuffer().getTextInRange(cursor.getCurrentWordBufferRange())
      words[word] = true
      return words
    }, {})

    const subsequenceMatchToType = (match) => {
      const editor = this.watchedBuffers.get(match.buffer)
      const scopeDescriptor = editor.scopeDescriptorForBufferPosition(match.positions[0])
      return this.providerConfig.scopeDescriptorToType(scopeDescriptor)
    }

    const matchToSuggestion = match => {
      return match.configSuggestion || {
        text: match.word,
        type: subsequenceMatchToType(match),
        characterMatchIndices: match.matchIndices
      }
    }

    const applyLocalityBonus = match => {
      if (match.buffer === currentEditorBuffer && match.score > 0) {
        var closest, currentDistance
        for (let k = 0; k < match.positions.length; k++) {
          currentDistance = Math.abs(match.positions[k].row - lastCursorRow)
          if (closest === undefined || currentDistance < closest) {
            closest = currentDistance
          }
        }
        match.score += Math.floor(11 / (1 + 0.04 * closest))
      }
      return match
    }

    const bufferResultsToSuggestions = matchesByBuffer => {
      const relevantMatches = []
      let matchedWords = {}
      let match

      for (let k = 0; k < matchesByBuffer.length; k++) {
        // The findWordsWithSubsequence method will return `null`
        // if the async work was cancelled due to the buffer being
        // mutated since it was enqueued. We return `null` in this
        // case because `getSuggestions` will be called again anyway.
        if (!matchesByBuffer[k]) return null

        for (let l = 0; l < matchesByBuffer[k].length; l++) {
          match = matchesByBuffer[k][l]

          if (matchedWords.hasOwnProperty(match.word)) continue

          if (wordsUnderCursors[match.word]) continue

          if (this.strictMatching && match.word.indexOf(prefix) !== 0) continue

          if (k < matchesByBuffer.length - 1) {
            match.buffer = buffers[k]
          }

          relevantMatches.push(
            this.useLocalityBonus ? applyLocalityBonus(match) : match
          )

          matchedWords[match.word] = true
        }
      }

      return relevantMatches
        .sort(compareMatches)
        .slice(0, this.maxSuggestions)
        .map(matchToSuggestion)
    }

    return Promise
      .all(
        buffers
          .map(this.bufferToSubsequenceMatches.bind(this, prefix, additionalWordCharacters))
          .concat(configMatches)
      )
      .then(bufferResultsToSuggestions)
  }
}

const compareMatches = (a, b) => {
  if (a.score - b.score === 0) {
    return a.word.length - b.word.length
  }
  return b.score - a.score
}
