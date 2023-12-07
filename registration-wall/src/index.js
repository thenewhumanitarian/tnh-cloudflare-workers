addEventListener('fetch', event => {
	event.respondWith(handleRequest(event.request))
})

async function handleRequest(request) {
	const corsHeaders = {
		"Access-Control-Allow-Origin": "*", // Replace with the actual origin
		"Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type", // Include any custom headers you use
	};

	// Handle OPTIONS (preflight) request
	if (request.method === "OPTIONS") {
		return new Response(null, { headers: corsHeaders });
	}

	try {
		const formData = await request.json();
		const { firstName, lastName, email, tagName, interests, gaClientId, existing } = formData;

		console.log(formData);

		// Basic validation
		// if (!firstName || !lastName || !email.includes('@')) {
		// 	return new Response(JSON.stringify({ error: 'Some required form fields are empty or invalid.' }), {
		// 		status: 400,
		// 		headers: { "Access-Control-Allow-Origin": "*" } // CORS header
		// 	});
		// }

		const emailHash = md5(email);
		const memberExists = await checkIfMemberExists(emailHash);

		if (memberExists) {
			try {
				// First, try to add the tag to the member
				await addTagToMember(emailHash, tagName, interests);

				// If successful, then send the GA4 event
				await sendGA4Event('registration_wall', { status: 'member_existed', email: email }, gaClientId, GA_MEASUREMENT_ID, GA_API_SECRET);

				// Respond that the member exists and the tag was added
				return new Response(JSON.stringify({ message: "Member exists. Tag added." }), {
					status: 200,
					headers: { "Access-Control-Allow-Origin": "*" } // CORS header
				});
			} catch (error) {
				// Handle any errors that occurred in the addTagToMember or sendGA4Event function
				console.error('Error:', error);

				// Respond with an error message
				return new Response(JSON.stringify({ message: "An error occurred." }), {
					status: 500,
					headers: { "Access-Control-Allow-Origin": "*" } // CORS header
				});
			}
		} else {
			if (existing === 'yes') {
				return new Response(JSON.stringify({ success: false, error: "Sorry, this email address wasn't found in our database." }), {
					status: 500, // Internal Server Error
					headers: { "Access-Control-Allow-Origin": "*" }
				});
			} else {
				try {
					await createNewMailchimpMember(formData);
					// If creating member was successful, then send the GA4 event
					await sendGA4Event('registration_wall', { status: 'new_member', email: email }, gaClientId, GA_MEASUREMENT_ID, GA_API_SECRET);

					return new Response(JSON.stringify({ success: true }), {
						status: 200,
						headers: { "Access-Control-Allow-Origin": "*" } // CORS header
					});
				} catch (error) {
					// Handle any errors that occur during Mailchimp member creation
					console.error('Error creating Mailchimp member:', error);

					// You may choose to send a different response or handle the error appropriately
					return new Response(JSON.stringify({ success: false, error: 'Error creating member' }), {
						status: 500, // Internal Server Error
						headers: { "Access-Control-Allow-Origin": "*" }
					});
				}
			}
		}
	} catch (error) {
		console.error('Error:', error);
		return new Response(JSON.stringify({ error: 'An error occurred.' }), {
			status: 500,
			headers: { "Access-Control-Allow-Origin": "https://www.thenewhumanitarian.org" } // CORS header
		});
	}
}

// Example usage
// const GA_MEASUREMENT_ID = 'G-XXXXXXXXXX'; // Your GA4 Measurement ID
// const CLIENT_ID = 'your_client_id'; // Client ID, unique to each user
// const API_SECRET = 'your_api_secret'; // Your GA4 API Secret

async function sendGA4Event(event_name, event_params, client_id, measurement_id, api_secret) {
	try {
		const eventData = {
			client_id: client_id,
			events: [{
				name: event_name,
				params: event_params,
			}],
		};

		console.log(eventData.events[0])

		const response = await fetch(`https://www.google-analytics.com/mp/collect?measurement_id=${measurement_id}&api_secret=${api_secret}`, {
			method: 'POST',
			body: JSON.stringify(eventData),
			headers: {
				'Content-Type': 'application/json',
			},
		});

		if (!response.ok) {
			throw new Error(`Error: ${response.statusText}`);
		}

		console.log("Event sent to GA4 successfully");
	} catch (error) {
		console.error("Failed to send event to GA4:", error);
	}
}

// Hashing function using SHA-256
async function getEmailHash(email) {
	const encoder = new TextEncoder();
	const data = encoder.encode(email.toLowerCase());
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	return bufferToHex(hashBuffer);
}

function bufferToHex(buffer) {
	const hex = Array.from(new Uint8Array(buffer))
		.map(b => b.toString(16).padStart(2, '0'))
		.join('');
	return hex;
}

// Function to check if a Mailchimp member exists
async function checkIfMemberExists(emailHash) {
	// Use Cloudflare environment variables for API key and server prefix
	const response = await fetch(`https://${MAILCHIMP_SERVER_PREFIX}.api.mailchimp.com/3.0/lists/${MAILCHIMP_LIST_ID}/members/${emailHash}`, {
		method: 'GET',
		headers: {
			'Authorization': `Bearer ${MAILCHIMP_API_KEY}`,
			'Content-Type': 'application/json'
		}
	});

	return response.status === 200;
}

// Function to add a new member to Mailchimp
async function createNewMailchimpMember(data) {
	const interestsArray = Array.isArray(data.interests) ? data.interests : [];
	const combinedTags = interestsArray.concat([data.tagName]);

	const memberData = {
		email_address: data.email,
		status: "subscribed",
		tags: combinedTags,
		merge_fields: {
			FNAME: data.firstName,
			LNAME: data.lastName,
			ORG: data.organisation,
			MMERGE6: data.jobTitle
		}
	};

	const response = await fetch(`https://${MAILCHIMP_SERVER_PREFIX}.api.mailchimp.com/3.0/lists/${MAILCHIMP_LIST_ID}/members/`, {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${MAILCHIMP_API_KEY}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(memberData)
	});

	if (!response.ok) {
		// Handle errors
		throw new Error('Failed to create new Mailchimp member');
	} else {
		return new Response(JSON.stringify({ message: "Success" }), {
			status: 200,
		});
	}
}

// Function to add a tag to an existing Mailchimp member
async function addTagToMember(emailHash, tagName, interests) {
	const tagData = {
		tags: [{ name: tagName, status: 'active' }]
	};

	// Concat tagData with the array in the interests field
	if (Array.isArray(interests)) {
		tagData.tags = tagData.tags.concat(interests.map(interest => ({ name: interest, status: 'active' })));
	}

	const response = await fetch(`https://${MAILCHIMP_SERVER_PREFIX}.api.mailchimp.com/3.0/lists/${MAILCHIMP_LIST_ID}/members/${emailHash}/tags`, {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${MAILCHIMP_API_KEY}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(tagData)
	});

	if (!response.ok) {
		// Handle errors
		throw new Error('Failed to add tag to Mailchimp member');
	} else {
		console.log(response);
		// Success
		console.log('Tag added to Mailchimp member');
	}

	const contentType = response.headers.get("content-type");
	if (response.ok && contentType && contentType.includes("application/json")) {
		return await response;
	} else {
		// Handle non-JSON or empty responses appropriately
		console.log("Non-JSON or empty response received");
		return null; // or handle as needed
	}

	return await response.json();
}

function md5cycle(x, k) {
	var a = x[0], b = x[1], c = x[2], d = x[3];

	a = ff(a, b, c, d, k[0], 7, -680876936);
	d = ff(d, a, b, c, k[1], 12, -389564586);
	c = ff(c, d, a, b, k[2], 17, 606105819);
	b = ff(b, c, d, a, k[3], 22, -1044525330);
	a = ff(a, b, c, d, k[4], 7, -176418897);
	d = ff(d, a, b, c, k[5], 12, 1200080426);
	c = ff(c, d, a, b, k[6], 17, -1473231341);
	b = ff(b, c, d, a, k[7], 22, -45705983);
	a = ff(a, b, c, d, k[8], 7, 1770035416);
	d = ff(d, a, b, c, k[9], 12, -1958414417);
	c = ff(c, d, a, b, k[10], 17, -42063);
	b = ff(b, c, d, a, k[11], 22, -1990404162);
	a = ff(a, b, c, d, k[12], 7, 1804603682);
	d = ff(d, a, b, c, k[13], 12, -40341101);
	c = ff(c, d, a, b, k[14], 17, -1502002290);
	b = ff(b, c, d, a, k[15], 22, 1236535329);

	a = gg(a, b, c, d, k[1], 5, -165796510);
	d = gg(d, a, b, c, k[6], 9, -1069501632);
	c = gg(c, d, a, b, k[11], 14, 643717713);
	b = gg(b, c, d, a, k[0], 20, -373897302);
	a = gg(a, b, c, d, k[5], 5, -701558691);
	d = gg(d, a, b, c, k[10], 9, 38016083);
	c = gg(c, d, a, b, k[15], 14, -660478335);
	b = gg(b, c, d, a, k[4], 20, -405537848);
	a = gg(a, b, c, d, k[9], 5, 568446438);
	d = gg(d, a, b, c, k[14], 9, -1019803690);
	c = gg(c, d, a, b, k[3], 14, -187363961);
	b = gg(b, c, d, a, k[8], 20, 1163531501);
	a = gg(a, b, c, d, k[13], 5, -1444681467);
	d = gg(d, a, b, c, k[2], 9, -51403784);
	c = gg(c, d, a, b, k[7], 14, 1735328473);
	b = gg(b, c, d, a, k[12], 20, -1926607734);

	a = hh(a, b, c, d, k[5], 4, -378558);
	d = hh(d, a, b, c, k[8], 11, -2022574463);
	c = hh(c, d, a, b, k[11], 16, 1839030562);
	b = hh(b, c, d, a, k[14], 23, -35309556);
	a = hh(a, b, c, d, k[1], 4, -1530992060);
	d = hh(d, a, b, c, k[4], 11, 1272893353);
	c = hh(c, d, a, b, k[7], 16, -155497632);
	b = hh(b, c, d, a, k[10], 23, -1094730640);
	a = hh(a, b, c, d, k[13], 4, 681279174);
	d = hh(d, a, b, c, k[0], 11, -358537222);
	c = hh(c, d, a, b, k[3], 16, -722521979);
	b = hh(b, c, d, a, k[6], 23, 76029189);
	a = hh(a, b, c, d, k[9], 4, -640364487);
	d = hh(d, a, b, c, k[12], 11, -421815835);
	c = hh(c, d, a, b, k[15], 16, 530742520);
	b = hh(b, c, d, a, k[2], 23, -995338651);

	a = ii(a, b, c, d, k[0], 6, -198630844);
	d = ii(d, a, b, c, k[7], 10, 1126891415);
	c = ii(c, d, a, b, k[14], 15, -1416354905);
	b = ii(b, c, d, a, k[5], 21, -57434055);
	a = ii(a, b, c, d, k[12], 6, 1700485571);
	d = ii(d, a, b, c, k[3], 10, -1894986606);
	c = ii(c, d, a, b, k[10], 15, -1051523);
	b = ii(b, c, d, a, k[1], 21, -2054922799);
	a = ii(a, b, c, d, k[8], 6, 1873313359);
	d = ii(d, a, b, c, k[15], 10, -30611744);
	c = ii(c, d, a, b, k[6], 15, -1560198380);
	b = ii(b, c, d, a, k[13], 21, 1309151649);
	a = ii(a, b, c, d, k[4], 6, -145523070);
	d = ii(d, a, b, c, k[11], 10, -1120210379);
	c = ii(c, d, a, b, k[2], 15, 718787259);
	b = ii(b, c, d, a, k[9], 21, -343485551);

	x[0] = add32(a, x[0]);
	x[1] = add32(b, x[1]);
	x[2] = add32(c, x[2]);
	x[3] = add32(d, x[3]);

}

function cmn(q, a, b, x, s, t) {
	a = add32(add32(a, q), add32(x, t));
	return add32((a << s) | (a >>> (32 - s)), b);
}

function ff(a, b, c, d, x, s, t) {
	return cmn((b & c) | ((~b) & d), a, b, x, s, t);
}

function gg(a, b, c, d, x, s, t) {
	return cmn((b & d) | (c & (~d)), a, b, x, s, t);
}

function hh(a, b, c, d, x, s, t) {
	return cmn(b ^ c ^ d, a, b, x, s, t);
}

function ii(a, b, c, d, x, s, t) {
	return cmn(c ^ (b | (~d)), a, b, x, s, t);
}

function md51(s) {
	txt = '';
	var n = s.length,
		state = [1732584193, -271733879, -1732584194, 271733878], i;
	for (i = 64; i <= s.length; i += 64) {
		md5cycle(state, md5blk(s.substring(i - 64, i)));
	}
	s = s.substring(i - 64);
	var tail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
	for (i = 0; i < s.length; i++)
		tail[i >> 2] |= s.charCodeAt(i) << ((i % 4) << 3);
	tail[i >> 2] |= 0x80 << ((i % 4) << 3);
	if (i > 55) {
		md5cycle(state, tail);
		for (i = 0; i < 16; i++) tail[i] = 0;
	}
	tail[14] = n * 8;
	md5cycle(state, tail);
	return state;
}

/* there needs to be support for Unicode here,
 * unless we pretend that we can redefine the MD-5
 * algorithm for multi-byte characters (perhaps
 * by adding every four 16-bit characters and
 * shortening the sum to 32 bits). Otherwise
 * I suggest performing MD-5 as if every character
 * was two bytes--e.g., 0040 0025 = @%--but then
 * how will an ordinary MD-5 sum be matched?
 * There is no way to standardize text to something
 * like UTF-8 before transformation; speed cost is
 * utterly prohibitive. The JavaScript standard
 * itself needs to look at this: it should start
 * providing access to strings as preformed UTF-8
 * 8-bit unsigned value arrays.
 */
function md5blk(s) { /* I figured global was faster.   */
	var md5blks = [], i; /* Andy King said do it this way. */
	for (i = 0; i < 64; i += 4) {
		md5blks[i >> 2] = s.charCodeAt(i)
			+ (s.charCodeAt(i + 1) << 8)
			+ (s.charCodeAt(i + 2) << 16)
			+ (s.charCodeAt(i + 3) << 24);
	}
	return md5blks;
}

var hex_chr = '0123456789abcdef'.split('');

function rhex(n) {
	var s = '', j = 0;
	for (; j < 4; j++)
		s += hex_chr[(n >> (j * 8 + 4)) & 0x0F]
			+ hex_chr[(n >> (j * 8)) & 0x0F];
	return s;
}

function hex(x) {
	for (var i = 0; i < x.length; i++)
		x[i] = rhex(x[i]);
	return x.join('');
}

function md5(s) {
	return hex(md51(s));
}

/* this function is much faster,
so if possible we use it. Some IEs
are the only ones I know of that
need the idiotic second function,
generated by an if clause.  */

function add32(a, b) {
	return (a + b) & 0xFFFFFFFF;
}

if (md5('hello') != '5d41402abc4b2a76b9719d911017c592') {
	function add32(x, y) {
		var lsw = (x & 0xFFFF) + (y & 0xFFFF),
			msw = (x >> 16) + (y >> 16) + (lsw >> 16);
		return (msw << 16) | (lsw & 0xFFFF);
	}
}