const pmap = require("promise.map")
const deepEqual = require("deep-equal")

async function clean(col, doc) {
	if (Object.prototype.toString.call(doc) === "[object Object]") {
		if (doc._array) {
			let arr = []
			delete doc._array
			const entries = Object.entries(doc)

			for (let i = 0; i < entries.length; i++) {
				const [index, value] = entries[i]
				arr[index] = await clean(col, value)
			}

			return arr
		} else {
			let obj = {}
			const entries = Object.entries(doc)

			for (let i = 0; i < entries.length; i++) {
				const [key, value] = entries[i]
				obj[key] = await clean(col, value)
			}

			return obj
		}
	} else if (typeof doc === "string" && doc.startsWith("~")) {
		return await new Promise((res, rej) => {
			col.get(doc).once(res)
		})
	} else {
		return doc
	}
}

function matches(doc, query) {
	const entries = Object.entries(query)

	for (let i = 0; i < entries.length; i++) {
		const [field, cond] = entries[i]
		const value = doc[field]

		if (Object.prototype.toString.call(cond) === "[object Object]") {
			if (cond.$not)
				if (!matches(value, cond.$not)) continue
				else return false
			if (cond.$eq)
				if (value === cond.$eq) continue
				else return false
			if (cond.$and) {
				const queries = cond.$and
				let match = true
				
				for (let i = 0; i < queries.length; i++) {
					if (!matches(value, queries[i])) {
						match = false
						break
					}
				}

				if (match) continue
				else return false
			}
			if (cond.$or) {
				const queries = cond.$or
				let match = false
				
				for (let i = 0; i < queries.length; i++) {
					if (matches(value, queries[i])) {
						match = true
						break
					}
				}

				if (match) continue
				else return false
			}

			const lt = cond.$lte ? value <= cond.$lte
			         : cond.$lt  ? value <  cond.$lt
			         : null

			const gt = cond.$gte ? value >= cond.$gte
			         : cond.$gt  ? value >  cond.$gt
			         : null

			if (lt === null && gt === null) continue
			else if (lt && gt || lt === null && gt || gt === null && lt) continue
			else return false
		}

		if (field === "$and") {
			const queries = cond
			let match = true
			
			for (let i = 0; i < queries.length; i++) {
				if (!matches(doc, queries[i])) {
					match = false
					break
				}
			}

			if (match) continue
			else return false
		}
		if (field === "$or") {
			const queries = cond
			let match = false
			
			for (let i = 0; i < queries.length; i++) {
				if (matches(doc, queries[i])) {
					match = true
					break
				}
			}

			if (match) continue
			else return false
		}

		if (value === cond) continue
		else return false
	}

	return true
}

function find(SEA, col, key, query, options) {
	return new Promise((res, rej) => {
		let docs = []
		let promises = []
		
		const sort = Object.keys(options.sort).length
		const fields = Object.keys(options.fields).length
		const limit = sort ? 0 : options.limit
		const skip = sort ? 0 : options.skip

		col.once(async data => {
			if (data) {
				delete data._
				const entries = Object.entries(data)

				for (let i = skip; i < entries.length; i++) {
					if (limit > 0 && docs.length >= limit) {
						break
					}

					let [id, doc] = entries[i]
					try {
						doc = await SEA.decrypt(doc, key)
						delete doc._
						doc = await clean(col, doc)
						if (matches(doc, query)) docs.push(doc)
					} catch(e) {
						rej(e)
						return
					}
				}

				if (sort) {
					const entries = Object.entries(options.sort)
					const compare = (a, b, field, asc) => {
						const compareType = (a, b) => {
							if (typeof a === "number" && typeof b == "number"
							|| Object.prototype.toString.call(a) === "[object Date]"
							&& Object.prototype.toString.call(b) === "[object Date]") {
								return a - b
							} else if (typeof a === "string" && typeof b === "string") {
								return a.localeCompare(b)
							}
						}
						return asc === 1
							? compareType(a[field], b[field])
							: compareType(b[field], a[field])
					}

					docs.sort((a, b) => {
						const [field, asc] = entries[0]
						let sort = compare(a, b, field, asc)

						for (let i = 1; i < entries.length; i++) {
							const [field, asc] = entries[i]
							sort = sort || compare(a, b, field, asc)
						}

						return sort
					})

					if (options.skip) {
						docs.splice(0, options.skip)
					}

					if (options.limit > 0 && docs.length > options.limit) {
						docs.splice(options.limit, docs.length - options.limit)
					}
				}

				if (fields) {
					const entries = Object.entries(options.fields)
					const includes = entries.filter(([_, inc]) => inc).map(([field, _]) => field)
					const excludes = entries.filter(([_, inc]) => !inc).map(([field, _]) => field)

					docs = docs.map(doc => {
						const keys = Object.keys(doc)
						for (let i = 0; i < keys.length; i++) {
							const field = keys[i]
							const not_included = includes.length && !includes.includes(field)
							const excluded = excludes.includes(field)
							if (not_included || excluded) {
								delete doc[field]
							}
						}
						return doc
					})
				}

				res(docs)
			} else {
				rej("Collection was not found")
			}
		})
	})
}

/*
 * Search through the entire collection and retrieve those who match the query
 * Options:
 *   sort - Fields to sort in ascending or descending order
 *   skip - The amount of documents to skip from the final result
 *   limit - Maximum amount of documents to return
 *   fields - Fields to include/exclude
 */
function Find(SEA, col, key, query, options) {
	function sort(sort) {
		return Find(SEA, col, key, query, {
			...options,
			sort,
		})
	}

	function skip(skip) {
		return Find(SEA, col, key, query, {
			...options,
			skip,
		})
	}

	function limit(limit) {
		return Find(SEA, col, key, query, {
			...options,
			limit,
		})
	}

	function fields(fields) {
		return Find(SEA, col, key, query, {
			...options,
			fields,
		})
	}

	function one() {
		options.one = true
		options.limit = 1
		return find(SEA, col, key, query, options)
	}

	function many() {
		options.one = false
		return find(SEA, col, key, query, options)
	}

	return {
		sort,
		skip,
		limit,
		fields,
		one,
		many,
	}
}

module.exports = Find