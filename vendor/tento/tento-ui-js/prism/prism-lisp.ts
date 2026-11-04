export namespace PrismLisp {
  /**
   * Returns the name of the type of the given value.
   *
   * @param {any} o
   * @returns {string}
   * @example
   * type(null)      === 'Null'
   * type(undefined) === 'Undefined'
   * type(123)       === 'Number'
   * type('foo')     === 'String'
   * type(true)      === 'Boolean'
   * type([1, 2])    === 'Array'
   * type({})        === 'Object'
   * type(String)    === 'Function'
   * type(/abc+/)    === 'RegExp'
   */
  const prismType = function (o) {
    return Object.prototype.toString.call(o).slice(8, -1);
  };

  let uniqueId = 0;
  const objId = function (o) {
    if (!o["__id"]) {
      Object.defineProperty(o, "__id", { value: ++uniqueId });
    }
    return o["__id"];
  };

  const prismClone = function deepClone(o, visited: object = {}) {
    let clone;
    let id;
    switch (prismType(o)) {
      case "Object":
        id = objId(o);
        if (visited[id]) {
          return visited[id];
        }
        clone = /** @type {Record<string, any>} */ {};
        visited[id] = clone;

        for (var key in o) {
          if (o.hasOwnProperty(key)) {
            clone[key] = deepClone(o[key], visited);
          }
        }

        return /** @type {any} */ clone;

      case "Array":
        id = objId(o);
        if (visited[id]) {
          return visited[id];
        }
        clone = [];
        visited[id] = clone;

        /** @type {Array} */ /** @type {any} */ o.forEach(function (v, i) {
          clone[i] = deepClone(v, visited);
        });

        return /** @type {any} */ clone;

      default:
        return o;
    }
  };

  export const prismLisp = () => {
    /**
     * Functions to construct regular expressions
     * e.g. (interactive ... or (interactive)
     *
     * @param {string} name
     * @returns {RegExp}
     */
    function simple_form(name: string): RegExp {
      return RegExp(/(\()/.source + "(?:" + name + ")" + /(?=[\s\)])/.source);
    }
    /**
     * booleans and numbers
     *
     * @param {string} pattern
     * @returns {RegExp}
     */
    function primitive(pattern: string): RegExp {
      return RegExp(
        /([\s([])/.source + "(?:" + pattern + ")" + /(?=[\s)])/.source,
      );
    }

    // Patterns in regular expressions

    // Symbol name. See https://www.gnu.org/software/emacs/manual/html_node/elisp/Symbol-Type.html
    // & and : are excluded as they are usually used for special purposes
    let symbol = /(?!\d)[-+*/~!@$%^=<>{}\w]+/.source;
    // symbol starting with & used in function arguments
    let marker = "&" + symbol;
    // Open parenthesis for look-behind
    let par = "(\\()";
    let endpar = "(?=\\))";
    // End the pattern with look-ahead space
    let space = "(?=\\s)";
    let nestedPar =
      /(?:[^()]|\((?:[^()]|\((?:[^()]|\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\))*\))*\))*/
        .source;

    let language = {
      // Three or four semicolons are considered a heading.
      // See https://www.gnu.org/software/emacs/manual/html_node/elisp/Comment-Tips.html
      heading: {
        pattern: /;;;.*/,
        alias: ["comment", "title"],
      },
      comment: /;.*/,
      string: {
        pattern: /"(?:[^"\\]|\\.)*"/,
        greedy: true,
        inside: {
          argument: /[-A-Z]+(?=[.,\s])/,
          symbol: RegExp("`" + symbol + "'"),
        },
      },
      "quoted-symbol": {
        pattern: RegExp("#?'" + symbol),
        alias: ["variable", "symbol"],
      },
      "lisp-property": {
        pattern: RegExp(":" + symbol),
        alias: "property",
      },
      splice: {
        pattern: RegExp(",@?" + symbol),
        alias: ["symbol", "variable"],
      },
      keyword: [
        {
          pattern: RegExp(
            par +
              "(?:and|(?:cl-)?letf|cl-loop|cond|cons|error|if|(?:lexical-)?let\\*?|message|not|null|or|provide|require|setq|unless|use-package|when|while)" +
              space,
          ),
          lookbehind: true,
        },
        {
          pattern: RegExp(
            par +
              "(?:append|by|collect|concat|do|finally|for|in|return)" +
              space,
          ),
          lookbehind: true,
        },
      ],
      declare: {
        pattern: simple_form(/declare/.source),
        lookbehind: true,
        alias: "keyword",
      },
      interactive: {
        pattern: simple_form(/interactive/.source),
        lookbehind: true,
        alias: "keyword",
      },
      boolean: {
        pattern: primitive(/nil|t/.source),
        lookbehind: true,
      },
      number: {
        pattern: primitive(/[-+]?\d+(?:\.\d*)?/.source),
        lookbehind: true,
      },
      defvar: {
        pattern: RegExp(par + "def(?:const|custom|group|var)\\s+" + symbol),
        lookbehind: true,
        inside: {
          keyword: /^def[a-z]+/,
          variable: RegExp(symbol),
        },
      },
      defun: {
        pattern: RegExp(
          par +
            /(?:cl-)?(?:defmacro|defun\*?)\s+/.source +
            symbol +
            /\s+\(/.source +
            nestedPar +
            /\)/.source,
        ),
        lookbehind: true,
        greedy: true,
        inside: {
          keyword: /^(?:cl-)?def\S+/,
          // See below, this property needs to be defined later so that it can
          // reference the language object.
          arguments: {
            inside: {
              sublist: {},
            },
          },
          function: {
            pattern: RegExp("(^\\s)" + symbol),
            lookbehind: true,
          },
          punctuation: /[()]/,
        },
      },
      lambda: {
        pattern: RegExp(
          par +
            "lambda\\s+\\(\\s*(?:&?" +
            symbol +
            "(?:\\s+&?" +
            symbol +
            ")*\\s*)?\\)",
        ),
        lookbehind: true,
        greedy: true,
        inside: {
          keyword: /^lambda/,
          // See below, this property needs to be defined later so that it can
          // reference the language object.
          arguments: {},
          punctuation: /[()]/,
        },
      },
      car: {
        pattern: RegExp(par + symbol),
        lookbehind: true,
      },
      punctuation: [
        // open paren, brackets, and close paren
        /(?:['`,]?\(|[)\[\]])/,
        // cons
        {
          pattern: /(\s)\.(?=\s)/,
          lookbehind: true,
        },
      ],
    };

    let arg = {
      "lisp-marker": RegExp(marker),
      varform: {
        pattern: RegExp(
          /\(/.source + symbol + /\s+(?=\S)/.source + nestedPar + /\)/.source,
        ),
        inside: language,
      },
      argument: {
        pattern: RegExp(/(^|[\s(])/.source + symbol),
        lookbehind: true,
        alias: "variable",
      },
      rest: language,
    };

    let forms = "\\S+(?:\\s+\\S+)*";

    let arglist = {
      pattern: RegExp(par + nestedPar + endpar),
      lookbehind: true,
      inside: {
        "rest-vars": {
          pattern: RegExp("&(?:body|rest)\\s+" + forms),
          inside: arg,
        },
        "other-marker-vars": {
          pattern: RegExp("&(?:aux|optional)\\s+" + forms),
          inside: arg,
        },
        keys: {
          pattern: RegExp("&key\\s+" + forms + "(?:\\s+&allow-other-keys)?"),
          inside: arg,
        },
        argument: {
          pattern: RegExp(symbol),
          alias: "variable",
        },
        punctuation: /[()]/,
      },
    };

    language["lambda"].inside.arguments = arglist;
    language["defun"].inside.arguments = prismClone(arglist);
    language["defun"].inside.arguments.inside.sublist = arglist;
    return language;
  };
}
