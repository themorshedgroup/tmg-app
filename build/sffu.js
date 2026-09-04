const {
  useState,
  useEffect,
  useRef
} = React;

// Embedded inside the TMG app (?embed=1): hide our own top bar; sync theme from the parent.
const EMBED_PARAMS = new URLSearchParams(location.search);
const EMBED = EMBED_PARAMS.get('embed') === '1';
const EMBED_THEME = EMBED_PARAMS.get('theme'); // 'dark' | 'light' | null

// ─── Design tokens (TMG Brand) ───────────────────────────────────
const C = {
  bg: '#FCFBF8',
  // paper
  surface: '#FFFFFF',
  // white cards
  surfaceHover: '#F3EBDA',
  // gold pale
  border: '#E4DFD4',
  // hairline
  navy: '#001A4A',
  // primary
  navyHover: '#0A2552',
  // navy depth
  gold: '#AD832F',
  // accent
  goldSoft: '#C9A45A',
  // gold on dark
  textPrimary: '#001A4A',
  // navy
  textSecondary: '#6B6B6B',
  // slate
  textMuted: '#9B9380',
  // muted
  red: '#C0392B',
  green: '#1E6B40',
  amber: '#B07A00',
  navBg: '#001A4A',
  // navy footer
  fontSans: "-apple-system, BlinkMacSystemFont, 'Jost', 'Helvetica Neue', Arial, sans-serif",
  fontDisplay: "'Cormorant Garamond', Georgia, serif"
};

// ─── Status config ───────────────────────────────────────────────
const STATUS = {
  in_progress: {
    label: 'In Progress',
    color: '#1E6B40',
    dot: '#1E6B40',
    bg: '#E8F5EE'
  },
  closed: {
    label: 'Closed',
    color: '#C0392B',
    dot: '#C0392B',
    bg: '#FDECEA'
  }
};

// ─── Sample Data ─────────────────────────────────────────────────
const PROPERTIES = [{
  id: 'p1',
  address: '1808 Forest Hill Dr',
  city: 'Austin, TX 78745',
  zillowUrl: 'https://www.zillow.com/homedetails/1808-Forest-Hill-Dr',
  agent: 'Tarek Morshed',
  price: '$775,000',
  beds: 4,
  baths: 2,
  sqft: '1,832'
}, {
  id: 'p2',
  address: '3707 Laurel Ledge Ln',
  city: 'Austin, TX 78731',
  zillowUrl: 'https://www.zillow.com/homedetails/3707-Laurel-Ledge-Ln',
  agent: 'Tarek Morshed',
  price: '$1,695,000',
  beds: 5,
  baths: 3.5,
  sqft: '3,750'
}, {
  id: 'p3',
  address: '4602 Jinx Ave',
  city: 'Austin, TX 78745',
  zillowUrl: 'https://www.zillow.com/homedetails/4602-Jinx-Ave',
  agent: 'Tarek Morshed',
  price: '$1,550,000',
  beds: 5,
  baths: 4.5,
  sqft: '2,850'
}, {
  id: 'p4',
  address: '10621 W Cave Loop',
  city: 'Dripping Springs, TX 78620',
  zillowUrl: 'https://www.zillow.com/homedetails/10621-W-Cave-Loop',
  agent: 'Tarek Morshed',
  price: '$705,000',
  beds: 4,
  baths: 3,
  sqft: '2,417'
}, {
  id: 'p5',
  address: '12313 Indian Mound Dr',
  city: 'Austin, TX 78758',
  zillowUrl: 'https://www.zillow.com/homedetails/12313-Indian-Mound-Dr',
  agent: 'Tarek Morshed',
  price: '$630,000',
  beds: 4,
  baths: 3,
  sqft: '2,081'
}];
const SHOWINGS = [
// 1808 Forest Hill Dr — 5 showings (real Supra data)
{
  id: 's1',
  pid: 'p1',
  agent: 'Kyle Baird',
  phone: '(832) 545-5593',
  office: 'Christies Intl Real Estate',
  date: 'May 27, 12:10 PM',
  status: 'in_progress'
}, {
  id: 's2',
  pid: 'p1',
  agent: 'Raymond Torres',
  phone: '(512) 297-5133',
  office: 'Compass RE Texas LLC',
  date: 'May 21, 1:21 PM',
  status: 'in_progress'
}, {
  id: 's3',
  pid: 'p1',
  agent: 'Katie Jackson',
  phone: '(512) 627-1625',
  office: 'Christies Intl Real Estate',
  date: 'May 20, 10:53 AM',
  status: 'in_progress'
}, {
  id: 's4',
  pid: 'p1',
  agent: 'Jennifer Shahry',
  phone: '(512) 636-0834',
  office: 'Compass RE Texas LLC',
  date: 'Apr 14, 3:57 PM',
  status: 'closed'
}, {
  id: 's5',
  pid: 'p1',
  agent: 'Amir Lancaster',
  phone: '(817) 683-8942',
  office: 'Compass RE Texas LLC',
  date: 'Apr 11, 3:12 PM',
  status: 'in_progress'
},
// 3707 Laurel Ledge Ln — 3 showings
{
  id: 's6',
  pid: 'p2',
  agent: 'Sarah Mitchell',
  phone: '(512) 449-8821',
  office: "Kuper Sotheby's Intl Realty",
  date: 'May 26, 2:30 PM',
  status: 'in_progress'
}, {
  id: 's7',
  pid: 'p2',
  agent: 'David Okafor',
  phone: '(512) 555-3344',
  office: 'eXp Realty',
  date: 'May 25, 11:00 AM',
  status: 'in_progress'
}, {
  id: 's8',
  pid: 'p2',
  agent: 'Lisa Hernandez',
  phone: '(210) 447-9921',
  office: 'Keller Williams Realty',
  date: 'May 23, 4:15 PM',
  status: 'in_progress'
},
// 4602 Jinx Ave — 3 showings
{
  id: 's9',
  pid: 'p3',
  agent: 'Michael Chang',
  phone: '(512) 882-1100',
  office: 'Redfin',
  date: 'May 28, 10:00 AM',
  status: 'in_progress'
}, {
  id: 's10',
  pid: 'p3',
  agent: 'Patricia Williams',
  phone: '(737) 206-5583',
  office: 'Coldwell Banker Realty',
  date: 'May 27, 3:45 PM',
  status: 'in_progress'
}, {
  id: 's11',
  pid: 'p3',
  agent: 'Marcus Webb',
  phone: '(512) 730-4421',
  office: 'Bramlett Residential',
  date: 'May 24, 1:00 PM',
  status: 'in_progress'
},
// 10621 W Cave Loop — 2 showings
{
  id: 's12',
  pid: 'p4',
  agent: 'Elena Vasquez',
  phone: '(512) 334-7780',
  office: 'Austin Home Hunters',
  date: 'May 27, 11:30 AM',
  status: 'in_progress'
}, {
  id: 's13',
  pid: 'p4',
  agent: 'Tom Nguyen',
  phone: '(512) 619-2255',
  office: 'Horizon Realty Group',
  date: 'May 22, 3:00 PM',
  status: 'closed'
},
// 12313 Indian Mound Dr — 2 showings
{
  id: 's14',
  pid: 'p5',
  agent: 'Brittany Fontenot',
  phone: '(512) 401-8833',
  office: 'JBGoodwin Realtors',
  date: 'May 26, 10:15 AM',
  status: 'in_progress'
}, {
  id: 's15',
  pid: 'p5',
  agent: 'James Oduya',
  phone: '(512) 778-9901',
  office: 'Compass RE Texas LLC',
  date: 'May 20, 2:45 PM',
  status: 'in_progress'
}];
const SMS_THREADS = {
  s1: [{
    dir: 'out',
    touch: 1,
    time: 'May 28 · 10:02 AM',
    body: "Hi Kyle! This is Tarek with The Morshed Group. Just following up on your showing at 1808 Forest Hill Dr ($775K) yesterday — did your clients enjoy the property? Any feedback is appreciated!"
  }, {
    dir: 'in',
    time: 'May 28 · 11:34 AM',
    body: "Hi Tarek! Yes they really liked it. Good size, loved the backyard. A bit concerned about the price relative to the kitchen needing an update. Going to think it over."
  }],
  s2: [{
    dir: 'out',
    touch: 1,
    time: 'May 22 · 10:01 AM',
    body: "Hi Raymond! This is Tarek with The Morshed Group. Following up on your showing at 1808 Forest Hill Dr on May 21 — how did your clients feel about the property?"
  }, {
    dir: 'out',
    touch: 2,
    time: 'May 24 · 10:00 AM',
    body: "Hi Raymond, just checking back in on 1808 Forest Hill Dr — did your clients have any thoughts to share? Happy to answer questions too!"
  }],
  s3: [{
    dir: 'out',
    touch: 1,
    time: 'May 21 · 10:01 AM',
    body: "Hi Katie! Tarek here from The Morshed Group. Just following up on your showing at 1808 Forest Hill Dr on May 20 — how did it go with your clients?"
  }],
  s4: [{
    dir: 'out',
    touch: 1,
    time: 'Apr 15 · 10:00 AM',
    body: "Hi Jennifer! This is Tarek with The Morshed Group. Following up on your showing at 1808 Forest Hill Dr — did your clients have any feedback on the property?"
  }, {
    dir: 'out',
    touch: 2,
    time: 'Apr 17 · 10:00 AM',
    body: "Hi Jennifer, one more follow-up on 1808 Forest Hill Dr — any thoughts from your clients? No worries if the timing isn't right."
  }, {
    dir: 'out',
    touch: 3,
    time: 'Apr 19 · 10:00 AM',
    body: "Hi Jennifer, last check-in on 1808 Forest Hill Dr. Feel free to reach out anytime if your clients have questions. Thanks!"
  }],
  s6: [{
    dir: 'out',
    touch: 1,
    time: 'May 27 · 10:00 AM',
    body: "Hi Sarah! This is Tarek with The Morshed Group. Following up on your showing at 3707 Laurel Ledge Ln ($1.695M) yesterday — did your clients have any feedback?"
  }, {
    dir: 'in',
    time: 'May 27 · 12:15 PM',
    body: "They absolutely loved it! Stunning home. They're seriously considering making an offer — can you send over the seller's disclosures?"
  }],
  s7: [{
    dir: 'out',
    touch: 1,
    time: 'May 26 · 10:00 AM',
    body: "Hi David! This is Tarek with The Morshed Group. Following up on your showing at 3707 Laurel Ledge Ln on May 25 — how did your clients like it?"
  }, {
    dir: 'out',
    touch: 2,
    time: 'May 28 · 10:00 AM',
    body: "Hi David, just a quick follow-up on 3707 Laurel Ledge Ln — any thoughts from your buyers? We're getting good activity on this one!"
  }],
  s10: [{
    dir: 'out',
    touch: 1,
    time: 'May 28 · 10:01 AM',
    body: "Hi Patricia! This is Tarek with The Morshed Group. Following up on your showing at 4602 Jinx Ave ($1.55M) yesterday — how did your clients feel about it?"
  }, {
    dir: 'in',
    time: 'May 28 · 2:08 PM',
    body: "Great showing! My clients loved the open floor plan and the kitchen. They want to come back for a second look this weekend if possible."
  }],
  s11: [{
    dir: 'out',
    touch: 1,
    time: 'May 25 · 10:00 AM',
    body: "Hi Marcus! Tarek here from The Morshed Group. Following up on your showing at 4602 Jinx Ave on May 24 — any feedback from your clients?"
  }],
  s13: [{
    dir: 'out',
    touch: 1,
    time: 'May 23 · 10:00 AM',
    body: "Hi Tom! This is Tarek with The Morshed Group. Following up on your showing at 10621 W Cave Loop on May 22 — how did your clients like the property?"
  }, {
    dir: 'out',
    touch: 2,
    time: 'May 25 · 10:00 AM',
    body: "Hi Tom, checking back in on 10621 W Cave Loop — any thoughts from your buyers? Great Hill Country location at $705K."
  }, {
    dir: 'out',
    touch: 3,
    time: 'May 27 · 10:00 AM',
    body: "Hi Tom, last follow-up on 10621 W Cave Loop. Feel free to reach out anytime if questions come up. Thanks!"
  }],
  s14: [{
    dir: 'out',
    touch: 1,
    time: 'May 27 · 10:00 AM',
    body: "Hi Brittany! This is Tarek with The Morshed Group. Following up on your showing at 12313 Indian Mound Dr ($630K) yesterday — any feedback from your clients?"
  }, {
    dir: 'out',
    touch: 2,
    time: 'May 29 · 10:00 AM',
    body: "Hi Brittany, just a quick check-in on 12313 Indian Mound Dr — did your clients have any questions or thoughts?"
  }]
};

// ─── Helpers ─────────────────────────────────────────────────────
function getProperty(pid) {
  return PROPERTIES.find(p => p.id === pid);
}

// ─── Database helper (Supabase on production, mock on localhost) ──
const DB = {
  client() {
    return window.SupabaseAuth?._client || null;
  },
  async loadShowings() {
    if (!this.client()) {
      // localhost: enrich mock showings with propertyAddress
      return SHOWINGS.map(s => {
        const p = PROPERTIES.find(pr => pr.id === s.pid);
        return {
          ...s,
          propertyAddress: p?.address || ''
        };
      });
    }
    const {
      data,
      error
    } = await this.client().from('showings').select('*').order('created_at', {
      ascending: false
    });
    if (error) {
      console.error('[DB] loadShowings:', error.message);
      return [];
    }
    return (data || []).map(row => ({
      id: row.id,
      propertyAddress: row.property_address,
      agent: row.agent_name,
      phone: row.agent_phone || '—',
      office: row.agent_office || '—',
      date: row.showing_date || '—',
      status: row.status || 'in_progress',
      feedback: row.feedback || '',
      addedByName: row.added_by_name
    }));
  },
  async insertShowing(formData, property, user) {
    if (!this.client()) {
      return {
        id: 's' + Date.now(),
        propertyAddress: property.address,
        agent: formData.agent,
        phone: formData.phone || '—',
        office: formData.office || '—',
        date: formData.date || 'Just added',
        status: 'in_progress',
        feedback: ''
      };
    }
    const {
      data,
      error
    } = await this.client().from('showings').insert({
      property_address: property.address,
      property_city: property.city,
      property_mls: property.zillowUrl || null,
      property_price: property.price,
      property_beds: String(property.beds),
      property_baths: String(property.baths),
      property_sqft: property.sqft,
      agent_name: formData.agent,
      agent_phone: formData.phone || null,
      agent_office: formData.office || null,
      showing_date: formData.date || null,
      added_by_id: user?.id || null,
      added_by_name: user?.user_metadata?.full_name || user?.email || null
    }).select().single();
    if (error) throw error;
    return {
      id: data.id,
      propertyAddress: data.property_address,
      agent: data.agent_name,
      phone: data.agent_phone || '—',
      office: data.agent_office || '—',
      date: data.showing_date || '—',
      status: data.status,
      feedback: data.feedback || '',
      addedByName: data.added_by_name
    };
  },
  async updateShowing(id, fields) {
    if (!this.client()) return;
    const mapped = {};
    if (fields.agent !== undefined) mapped.agent_name = fields.agent;
    if (fields.phone !== undefined) mapped.agent_phone = fields.phone;
    if (fields.office !== undefined) mapped.agent_office = fields.office;
    if (fields.date !== undefined) mapped.showing_date = fields.date;
    if (fields.status !== undefined) mapped.status = fields.status;
    if (fields.feedback !== undefined) mapped.feedback = fields.feedback || null;
    const {
      error
    } = await this.client().from('showings').update(mapped).eq('id', id);
    if (error) console.error('[DB] updateShowing:', error.message);
  },
  async deleteShowing(id) {
    if (!this.client()) return;
    // Remove the conversation thread first (no FK cascade assumed), then the showing.
    await this.client().from('sms_messages').delete().eq('showing_id', id);
    const {
      error
    } = await this.client().from('showings').delete().eq('id', id);
    if (error) throw error;
  },
  async loadThread(showingId) {
    if (!this.client()) return SMS_THREADS[showingId] || [];
    const {
      data,
      error
    } = await this.client().from('sms_messages').select('*').eq('showing_id', showingId).order('sent_at', {
      ascending: true
    });
    if (error) {
      console.error('[DB] loadThread:', error.message);
      return [];
    }
    return (data || []).map(row => ({
      id: row.id,
      dir: row.direction,
      touch: row.touch_number,
      time: new Date(row.sent_at).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      }),
      body: row.body,
      sentByName: row.sent_by_name,
      status: row.status
    }));
  },
  async insertMessage(showingId, msg, user) {
    if (!this.client()) return msg;
    const {
      error
    } = await this.client().from('sms_messages').insert({
      showing_id: showingId,
      direction: 'out',
      touch_number: null,
      body: msg.body,
      sent_by_id: user?.id || null,
      sent_by_name: user?.user_metadata?.full_name || user?.email || null
    });
    if (error) console.error('[DB] insertMessage:', error.message);
  },
  // Sends a manual text via Quo (server-side) AND logs it to the thread.
  async sendSms(showingId, body) {
    if (!this.client()) return {
      ok: true,
      dev: true
    }; // dev/local: no real send
    const token = window.SupabaseAuth?._state?.session?.access_token || '';
    const res = await fetch('https://ipqoqhsnjubopybujetn.supabase.co/functions/v1/sffu-send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
        'apikey': 'sb_publishable_Jg-roLg8M-BZJ7dBfjEeig_HIdniPaV'
      },
      body: JSON.stringify({
        showing_id: showingId,
        body
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Send failed (' + res.status + ')');
    return data;
  },
  async loadProperties() {
    if (!this.client()) return PROPERTIES;
    const {
      data,
      error
    } = await this.client().from('properties').select('*').eq('archived', false).order('created_at', {
      ascending: false
    });
    if (error) {
      console.error('[DB] loadProperties:', error.message);
      return PROPERTIES;
    }
    if (!data || data.length === 0) return PROPERTIES;
    return data.map(row => ({
      id: row.id,
      address: row.address,
      city: '',
      zillowUrl: row.zillow_url || '',
      agent: row.listing_agent || '',
      price: '',
      beds: '',
      baths: '',
      sqft: ''
    }));
  },
  async loadArchivedProperties() {
    if (!this.client()) return [];
    const {
      data,
      error
    } = await this.client().from('properties').select('*').eq('archived', true).order('created_at', {
      ascending: false
    });
    if (error) {
      console.error('[DB] loadArchivedProperties:', error.message);
      return [];
    }
    return (data || []).map(row => ({
      id: row.id,
      address: row.address,
      city: '',
      zillowUrl: row.zillow_url || '',
      agent: row.listing_agent || '',
      price: '',
      beds: '',
      baths: '',
      sqft: ''
    }));
  },
  async archiveProperty(id) {
    if (!this.client()) return;
    const {
      error
    } = await this.client().from('properties').update({
      archived: true
    }).eq('id', id);
    if (error) console.error('[DB] archiveProperty:', error.message);
  },
  async restoreProperty(id) {
    if (!this.client()) return;
    const {
      error
    } = await this.client().from('properties').update({
      archived: false
    }).eq('id', id);
    if (error) console.error('[DB] restoreProperty:', error.message);
  },
  async deleteProperty(id) {
    if (!this.client()) return;
    const {
      error
    } = await this.client().from('properties').delete().eq('id', id);
    if (error) console.error('[DB] deleteProperty:', error.message);
  },
  async updateProperty(id, fields) {
    if (!this.client()) return;
    const mapped = {};
    if (fields.address !== undefined) mapped.address = fields.address;
    if (fields.zillowUrl !== undefined) mapped.zillow_url = fields.zillowUrl;
    if (fields.agent !== undefined) mapped.listing_agent = fields.agent;
    const {
      error
    } = await this.client().from('properties').update(mapped).eq('id', id);
    if (error) console.error('[DB] updateProperty:', error.message);
  },
  async loadTemplates() {
    if (!this.client()) return SMS_TEMPLATE_DEFAULTS.map(t => t.body);
    const {
      data,
      error
    } = await this.client().from('sms_templates').select('*').order('touch_number', {
      ascending: true
    });
    if (error) return SMS_TEMPLATE_DEFAULTS.map(t => t.body);
    // Map by touch_number (not array position) so a touch missing from
    // the DB — e.g. template 4 before it's ever been saved — falls back
    // to its own default instead of shifting every later template up.
    const byTouch = {};
    (data || []).forEach(row => {
      byTouch[row.touch_number] = row.body;
    });
    return SMS_TEMPLATE_DEFAULTS.map(t => byTouch[t.touch] ?? t.body);
  },
  async saveTemplates(bodies, user) {
    if (!this.client()) return;
    const now = new Date().toISOString();
    const userName = user?.user_metadata?.full_name || user?.email || null;
    const rows = SMS_TEMPLATE_DEFAULTS.map((t, i) => ({
      id: t.touch,
      touch_number: t.touch,
      day_offset: t.day,
      body: bodies[i] || t.body,
      updated_at: now,
      updated_by_name: userName
    }));
    const {
      error
    } = await this.client().from('sms_templates').upsert(rows, {
      onConflict: 'id'
    });
    if (error) throw error;
  },
  async loadSettings() {
    if (!this.client()) return {
      twilioPhone: '',
      sendTime: '',
      senderName: ''
    };
    const {
      data,
      error
    } = await this.client().from('app_settings').select('*').eq('id', 1).single();
    if (error || !data) return {
      twilioPhone: '',
      sendTime: '',
      senderName: ''
    };
    return {
      twilioPhone: data.twilio_phone_number || '',
      sendTime: data.send_time_local || '',
      senderName: data.sender_name || ''
    };
  },
  async saveSettings(fields, user) {
    if (!this.client()) return;
    const {
      error
    } = await this.client().from('app_settings').upsert({
      id: 1,
      twilio_phone_number: fields.twilioPhone || null,
      send_time_local: fields.sendTime || null,
      sender_name: fields.senderName || null,
      updated_at: new Date().toISOString(),
      updated_by_name: user?.user_metadata?.full_name || user?.email || null
    }, {
      onConflict: 'id'
    });
    if (error) throw error;
  },
  async insertProperty(formData, user) {
    if (!this.client()) {
      return {
        id: 'p' + Date.now(),
        address: formData.address,
        city: '',
        zillowUrl: formData.zillowUrl || '',
        agent: formData.agent || '',
        price: '',
        beds: '',
        baths: '',
        sqft: ''
      };
    }
    const {
      data,
      error
    } = await this.client().from('properties').insert({
      address: formData.address,
      zillow_url: formData.zillowUrl || null,
      listing_agent: formData.agent || null,
      added_by_name: user?.user_metadata?.full_name || user?.email || null
    }).select().single();
    if (error) throw error;
    return {
      id: data.id,
      address: data.address,
      city: '',
      zillowUrl: data.zillow_url || '',
      agent: data.listing_agent || '',
      price: '',
      beds: '',
      baths: '',
      sqft: ''
    };
  },
  // Active sales agents (profiles with the 'agent' access role) → sorted,
  // de-duplicated display names. Powers the Listing Agent picker on properties.
  async loadAgents() {
    if (!this.client()) return ['Tarek Morshed', 'Jane Smith', 'Carlos Reyes']; // localhost mock
    const {
      data,
      error
    } = await this.client().from('profiles').select('first_name, last_name, access, status').eq('status', 'active').contains('access', ['agent']);
    if (error) {
      console.error('[DB] loadAgents:', error.message);
      return [];
    }
    const names = (data || []).map(p => ((p.first_name || '') + ' ' + (p.last_name || '')).trim()).filter(Boolean);
    return Array.from(new Set(names)).sort((a, b) => a.localeCompare(b));
  }
};

// ─── Icons ───────────────────────────────────────────────────────
const Icon = {
  Grid: ({
    size = 22,
    color = C.textSecondary
  }) => /*#__PURE__*/React.createElement("svg", {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: color,
    strokeWidth: "1.8",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, /*#__PURE__*/React.createElement("rect", {
    x: "3",
    y: "3",
    width: "7",
    height: "7",
    rx: "1.5"
  }), /*#__PURE__*/React.createElement("rect", {
    x: "14",
    y: "3",
    width: "7",
    height: "7",
    rx: "1.5"
  }), /*#__PURE__*/React.createElement("rect", {
    x: "14",
    y: "14",
    width: "7",
    height: "7",
    rx: "1.5"
  }), /*#__PURE__*/React.createElement("rect", {
    x: "3",
    y: "14",
    width: "7",
    height: "7",
    rx: "1.5"
  })),
  Kanban: ({
    size = 22,
    color = C.textSecondary
  }) => /*#__PURE__*/React.createElement("svg", {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: color,
    strokeWidth: "1.8",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, /*#__PURE__*/React.createElement("rect", {
    x: "3",
    y: "3",
    width: "5",
    height: "18",
    rx: "1.5"
  }), /*#__PURE__*/React.createElement("rect", {
    x: "9.5",
    y: "3",
    width: "5",
    height: "13",
    rx: "1.5"
  }), /*#__PURE__*/React.createElement("rect", {
    x: "16",
    y: "3",
    width: "5",
    height: "16",
    rx: "1.5"
  })),
  Gear: ({
    size = 22,
    color = C.textSecondary
  }) => /*#__PURE__*/React.createElement("svg", {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: color,
    strokeWidth: "1.8",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, /*#__PURE__*/React.createElement("circle", {
    cx: "12",
    cy: "12",
    r: "3"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
  })),
  Menu: ({
    size = 22,
    color = C.textSecondary
  }) => /*#__PURE__*/React.createElement("svg", {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: color,
    strokeWidth: "2",
    strokeLinecap: "round"
  }, /*#__PURE__*/React.createElement("line", {
    x1: "3",
    y1: "6",
    x2: "21",
    y2: "6"
  }), /*#__PURE__*/React.createElement("line", {
    x1: "3",
    y1: "12",
    x2: "21",
    y2: "12"
  }), /*#__PURE__*/React.createElement("line", {
    x1: "3",
    y1: "18",
    x2: "21",
    y2: "18"
  })),
  X: ({
    size = 20,
    color = C.textSecondary
  }) => /*#__PURE__*/React.createElement("svg", {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: color,
    strokeWidth: "2",
    strokeLinecap: "round"
  }, /*#__PURE__*/React.createElement("line", {
    x1: "18",
    y1: "6",
    x2: "6",
    y2: "18"
  }), /*#__PURE__*/React.createElement("line", {
    x1: "6",
    y1: "6",
    x2: "18",
    y2: "18"
  })),
  Plus: ({
    size = 20,
    color = C.gold
  }) => /*#__PURE__*/React.createElement("svg", {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: color,
    strokeWidth: "2.2",
    strokeLinecap: "round"
  }, /*#__PURE__*/React.createElement("line", {
    x1: "12",
    y1: "5",
    x2: "12",
    y2: "19"
  }), /*#__PURE__*/React.createElement("line", {
    x1: "5",
    y1: "12",
    x2: "19",
    y2: "12"
  })),
  Upload: ({
    size = 20,
    color = C.gold
  }) => /*#__PURE__*/React.createElement("svg", {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: color,
    strokeWidth: "2",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, /*#__PURE__*/React.createElement("polyline", {
    points: "16 16 12 12 8 16"
  }), /*#__PURE__*/React.createElement("line", {
    x1: "12",
    y1: "12",
    x2: "12",
    y2: "21"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"
  })),
  Chevron: ({
    size = 16,
    color = C.textSecondary,
    down = true
  }) => /*#__PURE__*/React.createElement("svg", {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: color,
    strokeWidth: "2",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    style: {
      transform: down ? 'rotate(0deg)' : 'rotate(-90deg)',
      transition: 'transform 0.2s'
    }
  }, /*#__PURE__*/React.createElement("polyline", {
    points: "6 9 12 15 18 9"
  })),
  Msg: ({
    size = 14,
    color = C.textSecondary
  }) => /*#__PURE__*/React.createElement("svg", {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: color,
    strokeWidth: "2",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
  }))
};

// ─── Status Badge ─────────────────────────────────────────────────
function StatusBadge({
  status
}) {
  const {
    label,
    color,
    bg
  } = STATUS[status] || STATUS.in_progress;
  return /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: '0.68rem',
      fontWeight: 600,
      color,
      background: bg,
      border: `1px solid ${color}33`,
      borderRadius: 20,
      padding: '3px 9px',
      whiteSpace: 'nowrap'
    }
  }, label);
}

// ─── SMS Thread ───────────────────────────────────────────────────
// Delivery status for OUR outbound texts: sms_messages.status starts as whatever Quo's
// send response said (queued/sent) and is updated later by the sffu-inbound webhook once
// Quo confirms delivered/failed. Anything not yet confirmed shows as "Sent" — provisional,
// not a guarantee it landed — which is exactly the gap this label exists to close.
const SMS_STATUS_META = {
  delivered: {
    label: 'Delivered',
    color: C.green
  },
  failed: {
    label: 'Not delivered',
    color: C.red
  },
  undelivered: {
    label: 'Not delivered',
    color: C.red
  }
};
function smsStatusMeta(status) {
  return SMS_STATUS_META[status] || {
    label: 'Sent',
    color: C.textMuted
  };
}
function SmsThread({
  thread
}) {
  if (!thread.length) return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '12px 0 4px',
      textAlign: 'center',
      color: C.textMuted,
      fontSize: '0.8rem'
    }
  }, "No messages yet");
  return /*#__PURE__*/React.createElement("div", {
    style: {
      paddingTop: 12,
      display: 'flex',
      flexDirection: 'column',
      gap: 8
    }
  }, thread.map((msg, i) => {
    const isOut = msg.dir === 'out';
    const sm = isOut ? smsStatusMeta(msg.status) : null;
    return /*#__PURE__*/React.createElement("div", {
      key: i,
      style: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: isOut ? 'flex-end' : 'flex-start'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: '0.65rem',
        color: isOut ? C.gold : C.green,
        marginBottom: 3,
        paddingLeft: isOut ? 0 : 2,
        paddingRight: isOut ? 2 : 0,
        letterSpacing: '0.04em'
      }
    }, isOut ? msg.touch ? `Day ${msg.touch} · ${msg.time}` : `${msg.sentByName || 'You'} · ${msg.time}` : `Reply · ${msg.time}`), /*#__PURE__*/React.createElement("div", {
      style: {
        maxWidth: '88%',
        background: isOut ? C.navy : C.surfaceHover,
        border: `1px solid ${isOut ? C.navy : C.border}`,
        borderRadius: isOut ? '6px 6px 2px 6px' : '6px 6px 6px 2px',
        padding: '8px 12px',
        fontSize: '0.83rem',
        color: isOut ? '#FFFFFF' : C.textPrimary,
        lineHeight: 1.5
      }
    }, msg.body), sm ? /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: '0.62rem',
        color: sm.color,
        marginTop: 3,
        paddingRight: 2,
        letterSpacing: '0.03em',
        fontWeight: 600
      }
    }, sm.label) : null);
  }));
}

// ─── Listing Agent picker (multi-select + manual entry) ──────────
// value/onChange use comma-separated strings to stay compatible with the
// existing listing_agent text column — no DB schema change needed.
function AgentSelect({
  value,
  onChange,
  agents,
  style
}) {
  const selected = value ? value.split(',').map(s => s.trim()).filter(Boolean) : [];
  const [open, setOpen] = React.useState(false);
  const [custom, setCustom] = React.useState('');
  const ref = React.useRef(null);

  // Close on outside click
  React.useEffect(() => {
    if (!open) return;
    function handler(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);
  function toggle(name) {
    const next = selected.includes(name) ? selected.filter(n => n !== name) : [...selected, name];
    onChange(next.join(', '));
  }
  function addCustom() {
    const name = custom.trim();
    if (!name) return;
    if (!selected.includes(name)) onChange([...selected, name].join(', '));
    setCustom('');
  }

  // All options: DB agents + any selected names not yet in DB (preserves existing values)
  const dbAgents = agents || [];
  const allOptions = [...new Set([...dbAgents, ...selected])];
  const chipStyle = {
    background: C.navy + '18',
    color: C.navy,
    borderRadius: 4,
    padding: '2px 6px',
    fontSize: '0.76rem',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4
  };
  return /*#__PURE__*/React.createElement("div", {
    ref: ref,
    style: {
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: () => setOpen(o => !o),
    style: {
      ...style,
      minHeight: 36,
      cursor: 'pointer',
      display: 'flex',
      flexWrap: 'wrap',
      gap: 4,
      alignItems: 'center',
      paddingRight: 28,
      position: 'relative'
    }
  }, selected.length === 0 && /*#__PURE__*/React.createElement("span", {
    style: {
      color: C.textMuted,
      fontSize: '0.83rem'
    }
  }, "\u2014 Select or type agent \u2014"), selected.map(name => /*#__PURE__*/React.createElement("span", {
    key: name,
    style: chipStyle
  }, name, /*#__PURE__*/React.createElement("span", {
    onMouseDown: e => {
      e.stopPropagation();
      toggle(name);
    },
    style: {
      cursor: 'pointer',
      fontSize: 11,
      lineHeight: 1,
      opacity: 0.7
    }
  }, "\u2715"))), /*#__PURE__*/React.createElement("i", {
    className: "ti ti-chevron-down",
    style: {
      position: 'absolute',
      right: 8,
      top: '50%',
      transform: 'translateY(-50%)',
      fontSize: 13,
      color: C.textMuted,
      pointerEvents: 'none'
    }
  })), open && /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: 'calc(100% + 2px)',
      left: 0,
      right: 0,
      zIndex: 400,
      background: C.surface,
      border: `1px solid ${C.border}`,
      borderRadius: 8,
      boxShadow: '0 4px 20px rgba(0,26,74,0.13)',
      maxHeight: 220,
      overflowY: 'auto'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '7px 10px',
      borderBottom: `1px solid ${C.border}`,
      display: 'flex',
      gap: 6,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("input", {
    value: custom,
    onChange: e => setCustom(e.target.value),
    onKeyDown: e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addCustom();
      }
    },
    placeholder: "Type name + Enter to add manually",
    style: {
      flex: 1,
      border: 'none',
      outline: 'none',
      background: 'transparent',
      color: C.textPrimary,
      fontSize: '0.82rem',
      fontFamily: C.fontSans
    }
  }), custom.trim() && /*#__PURE__*/React.createElement("button", {
    onMouseDown: e => {
      e.preventDefault();
      addCustom();
    },
    style: {
      background: C.navy,
      color: '#fff',
      border: 'none',
      borderRadius: 5,
      padding: '3px 9px',
      fontSize: '0.75rem',
      cursor: 'pointer',
      fontFamily: C.fontSans
    }
  }, "Add")), allOptions.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '10px 12px',
      color: C.textMuted,
      fontSize: '0.82rem'
    }
  }, "No agents found"), allOptions.map(name => /*#__PURE__*/React.createElement("div", {
    key: name,
    onMouseDown: e => {
      e.preventDefault();
      toggle(name);
    },
    style: {
      padding: '8px 12px',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      fontSize: '0.84rem',
      color: C.textPrimary,
      background: selected.includes(name) ? C.navy + '10' : 'transparent'
    }
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    readOnly: true,
    checked: selected.includes(name),
    style: {
      accentColor: C.navy,
      cursor: 'pointer',
      pointerEvents: 'none'
    }
  }), name))));
}

// ─── Property Card (Overview) ─────────────────────────────────────
function PropertyCard({
  property,
  allShowings,
  user,
  onArchive,
  onDeleteShowing
}) {
  const [expanded, setExpanded] = useState(false);
  const [openShowingId, setOpenShowingId] = useState(null);
  const [editing, setEditing] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [editAddr, setEditAddr] = useState(property.address);
  const [editZillow, setEditZillow] = useState(property.zillowUrl || '');
  const [editAgent, setEditAgent] = useState(property.agent || '');
  const [dispAddr, setDispAddr] = useState(property.address);
  const [dispZillow, setDispZillow] = useState(property.zillowUrl || '');
  const [dispAgent, setDispAgent] = useState(property.agent || '');
  const [agents, setAgents] = useState([]);
  // Load the active-agent list lazily, the first time this card enters edit mode.
  useEffect(() => {
    if (editing && agents.length === 0) DB.loadAgents().then(setAgents);
  }, [editing]);
  const showings = allShowings.filter(s => s.propertyAddress === dispAddr);
  const active = showings.filter(s => s.status === 'in_progress').length;
  const closed = showings.filter(s => s.status === 'closed').length;
  const feedbackShowings = showings.filter(s => s.feedback && s.feedback.trim());
  const unreadCount = showings.filter(s => {
    const t = SMS_THREADS[s.id] || [];
    return t.length > 0 && t[t.length - 1].dir === 'in';
  }).length;
  async function handleSaveEdit() {
    setDispAddr(editAddr);
    setDispZillow(editZillow);
    setDispAgent(editAgent);
    setEditing(false);
    await DB.updateProperty(property.id, {
      address: editAddr,
      zillowUrl: editZillow,
      agent: editAgent
    });
  }
  function handleCancelEdit() {
    setEditAddr(dispAddr);
    setEditZillow(dispZillow);
    setEditAgent(dispAgent);
    setEditing(false);
  }
  const inputStyle = {
    width: '100%',
    padding: '7px 10px',
    border: `1px solid ${C.border}`,
    borderRadius: 8,
    background: C.surface,
    color: C.textPrimary,
    fontSize: '0.83rem',
    fontFamily: C.fontSans,
    outline: 'none'
  };

  // Minimalist emoji chip
  function EmojiChip({
    emoji,
    count,
    color
  }) {
    if (!count) return null;
    return /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 3,
        background: color + '18',
        borderRadius: 20,
        padding: '2px 7px'
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: '0.72rem'
      }
    }, emoji), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: '0.7rem',
        fontWeight: 600,
        color
      }
    }, count));
  }
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.surface,
      boxShadow: '0 2px 8px rgba(0,26,74,0.07), 0 1px 2px rgba(0,26,74,0.04)',
      borderRadius: 16,
      overflow: 'hidden',
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: () => {
      if (!editing) setExpanded(e => !e);
    },
    style: {
      padding: '14px 16px',
      cursor: editing ? 'default' : 'pointer'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      marginBottom: editing ? 12 : 3,
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 700,
      fontSize: '0.97rem',
      color: C.textPrimary,
      flex: 1,
      minWidth: 0
    }
  }, dispAddr), !editing && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 4,
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement(EmojiChip, {
    emoji: "\uD83D\uDC40",
    count: showings.length,
    color: C.gold
  }), /*#__PURE__*/React.createElement(EmojiChip, {
    emoji: "\uD83D\uDFE2",
    count: active,
    color: C.green
  }), /*#__PURE__*/React.createElement(EmojiChip, {
    emoji: "\uD83D\uDD34",
    count: closed,
    color: C.red
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 4,
      flexShrink: 0,
      background: unreadCount > 0 ? C.red + '18' : 'transparent',
      border: `1px solid ${unreadCount > 0 ? C.red + '44' : C.border}`,
      borderRadius: 12,
      padding: '3px 8px',
      minWidth: 38,
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-mail",
    style: {
      fontSize: 14,
      color: unreadCount > 0 ? C.red : C.textMuted
    }
  }), unreadCount > 0 && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: '0.72rem',
      fontWeight: 700,
      color: C.red,
      fontFamily: C.fontSans,
      lineHeight: 1
    }
  }, unreadCount))), /*#__PURE__*/React.createElement("button", {
    onClick: e => {
      e.stopPropagation();
      setEditing(true);
    },
    style: {
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      padding: '2px 4px',
      color: editing ? C.gold : C.textMuted,
      fontSize: 14,
      lineHeight: 1,
      display: 'flex',
      alignItems: 'center',
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-pencil"
  })), !editing && /*#__PURE__*/React.createElement(Icon.Chevron, {
    size: 14,
    color: C.textSecondary,
    down: expanded
  })), !editing && showings.length > 0 && /*#__PURE__*/React.createElement("button", {
    onClick: e => {
      e.stopPropagation();
      setShowFeedback(true);
    },
    style: {
      width: '100%',
      marginBottom: editing ? 0 : 10,
      padding: '8px 10px',
      background: 'none',
      border: `1px solid ${C.border}`,
      borderRadius: 10,
      color: C.navy,
      fontSize: '0.78rem',
      fontWeight: 500,
      cursor: 'pointer',
      fontFamily: C.fontSans,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-notes",
    style: {
      fontSize: 13
    }
  }), "Generate Summary"), editing ?
  /*#__PURE__*/
  /* ── Inline edit form ── */
  React.createElement("div", {
    onClick: e => e.stopPropagation()
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      marginBottom: 12
    }
  }, [{
    label: 'Property Address',
    val: editAddr,
    set: setEditAddr
  }, {
    label: 'Zillow URL',
    val: editZillow,
    set: setEditZillow,
    placeholder: 'https://www.zillow.com/homedetails/…'
  }].map(({
    label,
    val,
    set,
    placeholder
  }) => /*#__PURE__*/React.createElement("div", {
    key: label
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.65rem',
      color: C.textSecondary,
      marginBottom: 3,
      fontFamily: C.fontSans
    }
  }, label), /*#__PURE__*/React.createElement("input", {
    value: val,
    onChange: e => set(e.target.value),
    placeholder: placeholder,
    style: inputStyle
  }))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.65rem',
      color: C.textSecondary,
      marginBottom: 3,
      fontFamily: C.fontSans
    }
  }, "Listing Agent"), /*#__PURE__*/React.createElement(AgentSelect, {
    value: editAgent,
    onChange: setEditAgent,
    agents: agents,
    style: inputStyle
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: handleSaveEdit,
    style: {
      flex: 1,
      padding: '9px',
      background: C.navy,
      color: '#fff',
      border: 'none',
      borderRadius: 8,
      fontSize: '0.82rem',
      fontWeight: 500,
      cursor: 'pointer',
      fontFamily: C.fontSans
    }
  }, "Save"), /*#__PURE__*/React.createElement("button", {
    onClick: handleCancelEdit,
    style: {
      flex: 1,
      padding: '9px',
      background: 'none',
      color: C.textSecondary,
      border: `1px solid ${C.border}`,
      borderRadius: 8,
      fontSize: '0.82rem',
      cursor: 'pointer',
      fontFamily: C.fontSans
    }
  }, "Cancel")), /*#__PURE__*/React.createElement("button", {
    onClick: async e => {
      e.stopPropagation();
      if (!window.confirm('Archive this property? It will be hidden from the overview. You can restore it from Settings.')) return;
      await DB.archiveProperty(property.id);
      if (onArchive) onArchive(property.id);
    },
    style: {
      width: '100%',
      padding: '9px',
      background: 'none',
      color: C.red,
      border: `1px solid ${C.red}55`,
      borderRadius: 8,
      fontSize: '0.82rem',
      cursor: 'pointer',
      fontFamily: C.fontSans
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-archive",
    style: {
      marginRight: 6,
      fontSize: 13
    }
  }), "Archive Property")) : /*#__PURE__*/React.createElement(React.Fragment, null, dispZillow ? /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.75rem',
      marginBottom: 2
    }
  }, /*#__PURE__*/React.createElement("a", {
    href: dispZillow,
    target: "_blank",
    rel: "noopener noreferrer",
    onClick: e => e.stopPropagation(),
    style: {
      color: C.gold,
      textDecoration: 'none',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-external-link",
    style: {
      fontSize: 12
    }
  }), "View on Zillow")) : null, dispAgent ? /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.73rem',
      color: C.textMuted
    }
  }, dispAgent) : null)), expanded && !editing && /*#__PURE__*/React.createElement("div", {
    style: {
      borderTop: `1px solid ${C.border}`
    }
  }, showings.map(s => /*#__PURE__*/React.createElement(ShowingRow, {
    key: s.id,
    showing: s,
    property: property,
    user: user,
    isOpen: openShowingId === s.id,
    onToggle: forceOpen => setOpenShowingId(cur => forceOpen ? s.id : cur === s.id ? null : s.id),
    onDelete: id => {
      setOpenShowingId(cur => cur === id ? null : cur);
      if (onDeleteShowing) onDeleteShowing(id);
    }
  }))), showFeedback && /*#__PURE__*/React.createElement(FeedbackSummaryModal, {
    address: dispAddr,
    totalShowings: showings.length,
    feedbackShowings: feedbackShowings,
    onClose: () => setShowFeedback(false)
  }));
}

// ─── Feedback Summary Modal ────────────────────────────────────────
// Copy-pasteable rollup of every showing on this property that has
// feedback recorded — one block per agent, in the format Symon can
// paste straight into an email/report to the listing agent.
function FeedbackSummaryModal({
  address,
  totalShowings,
  feedbackShowings,
  onClose
}) {
  const [copied, setCopied] = useState(false);
  const hasFeedback = feedbackShowings.length > 0;
  const feedbackBlock = hasFeedback ? feedbackShowings.map(s => `${s.agent || 'Agent'}, ${s.office || 'Brokerage'}:\n ${s.feedback.trim()}`).join('\n\n') : 'No feedback received yet.';
  const summary = `Total # of showings: ${totalShowings}\n\n${feedbackBlock}`;
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(summary);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch (e) {
      alert('Could not copy automatically — select the text above and copy manually.');
    }
  }
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    onClick: onClose,
    style: {
      position: 'fixed',
      inset: 0,
      zIndex: 300,
      background: 'rgba(0,26,74,0.45)'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'fixed',
      left: 0,
      right: 0,
      bottom: 0,
      zIndex: 301,
      background: C.surface,
      borderRadius: '20px 20px 0 0',
      padding: '24px 20px 40px',
      boxShadow: '0 -4px 32px rgba(0,26,74,0.15)',
      maxHeight: '80vh',
      display: 'flex',
      flexDirection: 'column'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 4
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '1.2rem',
      fontStyle: 'italic',
      fontFamily: C.fontDisplay,
      color: C.navy
    }
  }, "Summary"), /*#__PURE__*/React.createElement("button", {
    onClick: onClose,
    style: {
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      padding: 4,
      color: C.textMuted,
      fontSize: 20,
      display: 'flex'
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-x"
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.78rem',
      color: C.textSecondary,
      marginBottom: 14
    }
  }, address), /*#__PURE__*/React.createElement("textarea", {
    readOnly: true,
    value: summary,
    rows: hasFeedback ? Math.min(16, 2 + feedbackShowings.length * 3) : 5,
    onClick: e => e.target.select(),
    style: {
      width: '100%',
      flex: 1,
      resize: 'none',
      border: `1px solid ${C.border}`,
      borderRadius: 10,
      background: C.bg,
      color: hasFeedback ? C.textPrimary : C.textMuted,
      fontSize: '0.85rem',
      fontFamily: C.fontSans,
      lineHeight: 1.6,
      fontStyle: hasFeedback ? 'normal' : 'italic',
      padding: 12,
      outline: 'none',
      marginBottom: 14
    }
  }), /*#__PURE__*/React.createElement("button", {
    onClick: handleCopy,
    style: {
      width: '100%',
      padding: 12,
      borderRadius: 12,
      border: 'none',
      background: copied ? C.green : C.navy,
      color: '#fff',
      fontSize: '0.88rem',
      fontWeight: 500,
      cursor: 'pointer',
      fontFamily: C.fontSans,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      transition: 'background 0.15s'
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: copied ? 'ti ti-check' : 'ti ti-copy'
  }), copied ? 'Copied!' : 'Copy to Clipboard')));
}
function StatChip({
  value,
  label,
  color
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      textAlign: 'center',
      background: C.surfaceHover,
      boxShadow: '0 1px 3px rgba(0,26,74,0.05)',
      borderRadius: 10,
      padding: '7px 4px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '1.3rem',
      fontWeight: 400,
      fontStyle: 'italic',
      color,
      fontFamily: C.fontDisplay
    }
  }, value), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.58rem',
      color: C.textSecondary,
      textTransform: 'uppercase',
      letterSpacing: '0.14em',
      marginTop: 1,
      fontFamily: C.fontSans
    }
  }, label));
}
function ShowingRow({
  showing,
  property,
  isOpen = false,
  onToggle = () => {},
  user,
  onDelete = () => {}
}) {
  const [status, setStatus] = useState(showing.status);
  const [localThread, setLocalThread] = useState(() => SMS_THREADS[showing.id] || []);
  const [threadLoaded, setThreadLoaded] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [editing, setEditing] = useState(false);
  // Manual-send template picker — lets a TC pick Day 1/2/3 or the "Reply
  // Received" template and auto-populate the reply box (pre-filled, still
  // editable) instead of typing a follow-up text from scratch.
  const [showTplPicker, setShowTplPicker] = useState(false);
  const [templates, setTemplates] = useState(null); // lazy-loaded: [day1, day2, day3, ack]
  function openTplPicker() {
    setShowTplPicker(v => !v);
    if (!templates) DB.loadTemplates().then(setTemplates);
  }
  function pickTemplate(body) {
    const filled = renderTemplate(body, {
      agent_name: showing.agent,
      property_address: showing.propertyAddress
    }, property, user);
    setReplyText(filled);
    setShowTplPicker(false);
  }

  // Load thread from DB when first expanded, then keep it live while open —
  // subscribe to new sms_messages rows so replies (and our own sends) appear
  // without a refresh. Unsubscribes when the row closes.
  useEffect(() => {
    if (!isOpen) return;
    if (!threadLoaded) {
      setThreadLoaded(true);
      DB.loadThread(showing.id).then(t => setLocalThread(t));
    }
    const client = DB.client();
    if (!client) return;
    const channel = client.channel('sms-' + showing.id).on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'sms_messages',
      filter: `showing_id=eq.${showing.id}`
    }, payload => {
      const row = payload.new;
      const incoming = {
        id: row.id,
        dir: row.direction,
        touch: row.touch_number,
        time: new Date(row.sent_at).toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit'
        }),
        body: row.body,
        sentByName: row.sent_by_name,
        status: row.status
      };
      setLocalThread(t => {
        if (t.some(m => m.id === incoming.id)) return t; // already have it
        const optimisticIdx = t.findIndex(m => !m.id && m.dir === 'out' && m.body === incoming.body);
        if (optimisticIdx !== -1) {
          // fill in our own optimistic send
          const copy = t.slice();
          copy[optimisticIdx] = incoming;
          return copy;
        }
        return [...t, incoming];
      });
    })
    // Delivery/failure confirmation arrives seconds-to-minutes AFTER the send, as a Quo
    // webhook that UPDATEs this same row's status (see sffu-inbound) — without this, an
    // already-open thread would show "Sent" forever even after Quo confirms it failed.
    .on('postgres_changes', {
      event: 'UPDATE',
      schema: 'public',
      table: 'sms_messages',
      filter: `showing_id=eq.${showing.id}`
    }, payload => {
      const row = payload.new;
      setLocalThread(t => t.map(m => m.id === row.id ? {
        ...m,
        status: row.status
      } : m));
    }).subscribe();
    return () => {
      client.removeChannel(channel);
    };
  }, [isOpen]);
  const [editAgent, setEditAgent] = useState(showing.agent);
  const [editPhone, setEditPhone] = useState(showing.phone);
  const [editOffice, setEditOffice] = useState(showing.office);
  const [editDate, setEditDate] = useState(showing.date);
  const [editFeedback, setEditFeedback] = useState(showing.feedback || '');
  // Display values (updated on save)
  const [dispAgent, setDispAgent] = useState(showing.agent);
  const [dispPhone, setDispPhone] = useState(showing.phone);
  const [dispOffice, setDispOffice] = useState(showing.office);
  const [dispDate, setDispDate] = useState(showing.date);
  const [dispFeedback, setDispFeedback] = useState(showing.feedback || '');
  const hasUnread = localThread.length > 0 && localThread[localThread.length - 1].dir === 'in';
  const inboundCount = localThread.filter(m => m.dir === 'in').length;
  async function handleSend() {
    const txt = replyText.trim();
    if (!txt) return;
    const senderName = user?.user_metadata?.full_name || user?.email || 'You';
    setReplyText('');
    try {
      await DB.sendSms(showing.id, txt); // real text via Quo + logged
      setLocalThread(t => [...t, {
        dir: 'out',
        touch: null,
        time: 'Just now',
        body: txt,
        sentByName: senderName
      }]);
    } catch (e) {
      setReplyText(txt); // restore so they can retry
      alert('Could not send the text: ' + (e.message || e));
    }
  }
  async function handleSaveEdit() {
    setDispAgent(editAgent);
    setDispPhone(editPhone);
    setDispOffice(editOffice);
    setDispDate(editDate);
    setDispFeedback(editFeedback);
    setEditing(false);
    await DB.updateShowing(showing.id, {
      agent: editAgent,
      phone: editPhone,
      office: editOffice,
      date: editDate,
      feedback: editFeedback
    });
  }
  function handleCancelEdit() {
    setEditAgent(dispAgent);
    setEditPhone(dispPhone);
    setEditOffice(dispOffice);
    setEditDate(dispDate);
    setEditFeedback(dispFeedback);
    setEditing(false);
  }
  const [deleting, setDeleting] = useState(false);
  async function handleDelete() {
    if (!window.confirm(`Delete this showing for ${dispAgent || 'this agent'}? This also removes its text conversation and cannot be undone.`)) return;
    setDeleting(true);
    try {
      await DB.deleteShowing(showing.id);
      onDelete(showing.id); // remove from the list (parent state)
    } catch (e) {
      setDeleting(false);
      alert('Could not delete the showing: ' + (e.message || e));
    }
  }
  const inputStyle = {
    width: '100%',
    padding: '7px 10px',
    border: `1px solid ${C.border}`,
    borderRadius: 8,
    background: C.surface,
    color: C.textPrimary,
    fontSize: '0.83rem',
    fontFamily: C.fontSans,
    outline: 'none'
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      borderBottom: `1px solid ${C.border}`
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: () => {
      if (!editing) onToggle();
    },
    style: {
      display: 'flex',
      alignItems: 'center',
      padding: '12px 16px',
      cursor: 'pointer',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement(Icon.Msg, {
    size: 15,
    color: inboundCount > 0 ? C.gold : C.textMuted
  }), inboundCount > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: -5,
      right: -7,
      minWidth: 15,
      height: 15,
      borderRadius: 8,
      background: C.red,
      border: `1.5px solid ${C.surface}`,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: '0.58rem',
      fontWeight: 700,
      color: '#fff',
      fontFamily: C.fontSans,
      padding: '0 2px'
    }
  }, inboundCount)), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.88rem',
      fontWeight: 500,
      color: C.textPrimary
    }
  }, dispAgent), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.72rem',
      color: C.textSecondary
    }
  }, dispDate, " \xB7 ", dispPhone), dispFeedback ? /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.72rem',
      color: C.textSecondary,
      marginTop: 2
    }
  }, "Feedback: ", /*#__PURE__*/React.createElement("span", {
    style: {
      fontStyle: 'italic',
      fontFamily: C.fontDisplay,
      fontSize: '0.82rem'
    }
  }, dispFeedback)) : null), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 5,
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: e => {
      e.stopPropagation();
      setEditing(true);
      onToggle(true);
    },
    style: {
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      padding: '2px 4px',
      color: C.textMuted,
      fontSize: 14,
      lineHeight: 1,
      display: 'flex',
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-pencil"
  })), /*#__PURE__*/React.createElement("select", {
    value: status,
    onClick: e => e.stopPropagation(),
    onChange: e => {
      e.stopPropagation();
      const v = e.target.value;
      setStatus(v);
      DB.updateShowing(showing.id, {
        status: v
      });
    },
    style: {
      padding: '3px 8px',
      border: `1px solid ${STATUS[status]?.color || '#888'}44`,
      borderRadius: 20,
      background: STATUS[status]?.bg || C.surfaceHover,
      color: STATUS[status]?.color || C.textSecondary,
      fontSize: '0.68rem',
      fontWeight: 600,
      fontFamily: C.fontSans,
      outline: 'none',
      cursor: 'pointer',
      appearance: 'none',
      WebkitAppearance: 'none'
    }
  }, /*#__PURE__*/React.createElement("option", {
    value: "in_progress"
  }, "In Progress"), /*#__PURE__*/React.createElement("option", {
    value: "closed"
  }, "Closed")), /*#__PURE__*/React.createElement(Icon.Chevron, {
    size: 13,
    color: C.textSecondary,
    down: isOpen
  }))), isOpen && /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.bg,
      borderTop: `1px solid ${C.border}`,
      padding: '12px 16px 16px'
    }
  }, editing ?
  /*#__PURE__*/
  /* ── Edit form ── */
  React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.62rem',
      fontWeight: 600,
      color: C.navy,
      letterSpacing: '0.1em',
      textTransform: 'uppercase',
      marginBottom: 10,
      fontFamily: C.fontSans
    }
  }, "Edit Showing Details"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      marginBottom: 12
    }
  }, [{
    label: 'Agent Name',
    val: editAgent,
    set: setEditAgent
  }, {
    label: 'Phone',
    val: editPhone,
    set: setEditPhone
  }, {
    label: 'Office',
    val: editOffice,
    set: setEditOffice
  }, {
    label: 'Date / Time',
    val: editDate,
    set: setEditDate
  }].map(({
    label,
    val,
    set
  }) => /*#__PURE__*/React.createElement("div", {
    key: label
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.65rem',
      color: C.textSecondary,
      marginBottom: 3,
      fontFamily: C.fontSans
    }
  }, label), /*#__PURE__*/React.createElement("input", {
    value: val,
    onChange: e => set(e.target.value),
    style: inputStyle
  }))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.65rem',
      color: C.textSecondary,
      marginBottom: 3,
      fontFamily: C.fontSans
    }
  }, "Feedback"), /*#__PURE__*/React.createElement("textarea", {
    value: editFeedback,
    onChange: e => setEditFeedback(e.target.value),
    placeholder: "e.g. Loved the backyard, concerned about kitchen update",
    rows: 2,
    style: {
      ...inputStyle,
      resize: 'none',
      lineHeight: 1.5
    }
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: handleSaveEdit,
    style: {
      flex: 1,
      padding: '9px',
      background: C.navy,
      color: '#fff',
      border: 'none',
      borderRadius: 8,
      fontSize: '0.82rem',
      fontWeight: 500,
      cursor: 'pointer',
      fontFamily: C.fontSans
    }
  }, "Save"), /*#__PURE__*/React.createElement("button", {
    onClick: handleCancelEdit,
    style: {
      flex: 1,
      padding: '9px',
      background: 'none',
      color: C.textSecondary,
      border: `1px solid ${C.border}`,
      borderRadius: 8,
      fontSize: '0.82rem',
      cursor: 'pointer',
      fontFamily: C.fontSans
    }
  }, "Cancel")), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 10,
      paddingTop: 10,
      borderTop: `1px solid ${C.border}`
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: handleDelete,
    disabled: deleting,
    style: {
      width: '100%',
      padding: '9px',
      background: 'none',
      color: C.red,
      border: `1px solid ${C.red}44`,
      borderRadius: 8,
      fontSize: '0.8rem',
      fontWeight: 500,
      cursor: deleting ? 'default' : 'pointer',
      opacity: deleting ? 0.6 : 1,
      fontFamily: C.fontSans,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-trash",
    style: {
      fontSize: 13
    }
  }), deleting ? 'Deleting…' : 'Delete Showing'))) :
  /*#__PURE__*/
  /* ── Normal view ── */
  React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.72rem',
      color: C.textMuted,
      marginBottom: 10
    }
  }, dispOffice), /*#__PURE__*/React.createElement(SmsThread, {
    thread: localThread
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 20,
      paddingTop: 14,
      borderTop: `1px solid ${C.border}`,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: '0.62rem',
      fontWeight: 600,
      color: C.navy,
      letterSpacing: '0.1em',
      textTransform: 'uppercase',
      fontFamily: C.fontSans
    }
  }, "Reply"), /*#__PURE__*/React.createElement("button", {
    onClick: openTplPicker,
    style: {
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      padding: '2px 4px',
      color: showTplPicker ? C.gold : C.textMuted,
      fontSize: '0.72rem',
      display: 'flex',
      alignItems: 'center',
      gap: 4,
      fontFamily: C.fontSans
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-message-2",
    style: {
      fontSize: 13
    }
  }), "Use a template")), showTplPicker && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexWrap: 'wrap',
      gap: 6,
      margin: '8px 0'
    }
  }, templates ? SMS_TEMPLATE_DEFAULTS.map((t, i) => /*#__PURE__*/React.createElement("button", {
    key: t.touch,
    onClick: () => pickTemplate(templates[i]),
    style: {
      padding: '5px 10px',
      borderRadius: 20,
      border: `1px solid ${C.border}`,
      background: C.surfaceHover,
      color: C.textPrimary,
      fontSize: '0.72rem',
      cursor: 'pointer',
      fontFamily: C.fontSans
    }
  }, t.label)) : /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: '0.72rem',
      color: C.textMuted,
      padding: '5px 0'
    }
  }, "Loading templates\u2026")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      alignItems: 'flex-end'
    }
  }, /*#__PURE__*/React.createElement("textarea", {
    rows: 2,
    placeholder: "Type a reply\u2026",
    value: replyText,
    onChange: e => setReplyText(e.target.value),
    onKeyDown: e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    style: {
      flex: 1,
      padding: '8px 12px',
      resize: 'none',
      border: `1px solid ${C.border}`,
      borderRadius: 8,
      background: C.surface,
      color: C.textPrimary,
      fontSize: '0.85rem',
      fontFamily: C.fontSans,
      outline: 'none',
      lineHeight: 1.5
    }
  }), /*#__PURE__*/React.createElement("button", {
    onClick: handleSend,
    style: {
      padding: '8px 14px',
      borderRadius: 8,
      border: 'none',
      background: replyText.trim() ? C.navy : C.border,
      color: replyText.trim() ? '#FFFFFF' : C.textMuted,
      fontSize: '0.8rem',
      fontWeight: 500,
      cursor: 'pointer',
      fontFamily: C.fontSans,
      transition: 'background 0.15s',
      flexShrink: 0,
      alignSelf: 'stretch'
    }
  }, "Send")))));
}

// ─── Overview Tab ─────────────────────────────────────────────────
function OverviewTab({
  user,
  liveShowings,
  properties,
  onArchive,
  onDeleteShowing
}) {
  const firstName = user?.user_metadata?.full_name?.split(' ')[0] || user?.email?.split('@')[0] || 'there';
  return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '20px 16px 32px'
    }
  }, !EMBED && /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 20
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '2.2rem',
      fontWeight: 400,
      fontStyle: 'italic',
      color: C.navy,
      fontFamily: C.fontDisplay
    }
  }, "Hi, ", firstName), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.7rem',
      color: C.textSecondary,
      marginTop: 4,
      letterSpacing: '0.16em',
      textTransform: 'uppercase',
      fontFamily: C.fontSans
    }
  }, "Showing Feedback Follow-Up App")), properties.map(p => /*#__PURE__*/React.createElement(PropertyCard, {
    key: p.id,
    property: p,
    allShowings: liveShowings,
    user: user,
    onArchive: onArchive,
    onDeleteShowing: onDeleteShowing
  })));
}

// ─── Archived Properties (used in Settings) ──────────────────────
function ArchivedProperties() {
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [threads, setThreads] = useState({}); // propId → showings[]
  const [showings, setShowings] = useState({}); // propId → showings[]

  async function load() {
    setLoading(true);
    const props = await DB.loadArchivedProperties();
    setItems(props);
    setLoaded(true);
    setLoading(false);
  }
  async function handleExpand(prop) {
    const id = prop.id;
    if (openId === id) {
      setOpenId(null);
      return;
    }
    setOpenId(id);
    // Load showings for this archived property if not yet loaded
    if (!showings[id]) {
      const client = DB.client();
      if (client) {
        const {
          data
        } = await client.from('showings').select('*').eq('property_address', prop.address).order('created_at', {
          ascending: false
        });
        const mapped = (data || []).map(row => ({
          id: row.id,
          agent: row.agent_name,
          phone: row.agent_phone || '—',
          office: row.agent_office || '—',
          date: row.showing_date || '—',
          status: row.status
        }));
        setShowings(prev => ({
          ...prev,
          [id]: mapped
        }));
        // Pre-load all threads
        for (const s of mapped) {
          const thread = await DB.loadThread(s.id);
          setThreads(prev => ({
            ...prev,
            [s.id]: thread
          }));
        }
      } else {
        // Mock: use SHOWINGS filtered by address
        const mock = SHOWINGS.filter(s => {
          const p = PROPERTIES.find(pr => pr.id === s.pid);
          return p?.address === prop.address;
        }).map(s => ({
          id: s.id,
          agent: s.agent,
          phone: s.phone,
          office: s.office,
          date: s.date,
          status: s.status
        }));
        setShowings(prev => ({
          ...prev,
          [id]: mock
        }));
        mock.forEach(s => setThreads(prev => ({
          ...prev,
          [s.id]: SMS_THREADS[s.id] || []
        })));
      }
    }
  }
  async function handleRestore(prop) {
    await DB.restoreProperty(prop.id);
    setItems(prev => prev.filter(p => p.id !== prop.id));
    if (openId === prop.id) setOpenId(null);
  }
  async function handleDeleteForever(prop) {
    if (!window.confirm(`Permanently delete "${prop.address}"? This cannot be undone.`)) return;
    await DB.deleteProperty(prop.id);
    setItems(prev => prev.filter(p => p.id !== prop.id));
    if (openId === prop.id) setOpenId(null);
  }
  if (!loaded) {
    return /*#__PURE__*/React.createElement(SectionCard, {
      title: "Archived Properties",
      mb: 14
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: '0.82rem',
        color: C.textSecondary,
        marginBottom: 14,
        lineHeight: 1.5
      }
    }, "Properties you've archived are stored here. You can restore or permanently delete them."), /*#__PURE__*/React.createElement("button", {
      onClick: load,
      disabled: loading,
      style: {
        width: '100%',
        padding: 12,
        background: 'none',
        border: `1px solid ${C.border}`,
        borderRadius: 12,
        color: C.navy,
        fontSize: '0.88rem',
        cursor: 'pointer',
        fontFamily: C.fontSans
      }
    }, loading ? 'Loading…' : 'Load Archived Properties'));
  }
  return /*#__PURE__*/React.createElement(SectionCard, {
    title: "Archived Properties",
    mb: 14
  }, items.length === 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.82rem',
      color: C.textMuted,
      textAlign: 'center',
      padding: '8px 0'
    }
  }, "No archived properties.") : items.map(prop => {
    const isOpen = openId === prop.id;
    const propShowings = showings[prop.id] || [];
    return /*#__PURE__*/React.createElement("div", {
      key: prop.id,
      style: {
        border: `1px solid ${C.border}`,
        borderRadius: 10,
        marginBottom: 10,
        overflow: 'hidden'
      }
    }, /*#__PURE__*/React.createElement("div", {
      onClick: () => handleExpand(prop),
      style: {
        padding: '11px 14px',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 8
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1,
        minWidth: 0
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: '0.9rem',
        fontWeight: 600,
        color: C.textPrimary
      }
    }, prop.address), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: '0.72rem',
        color: C.textSecondary,
        marginTop: 1,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        flexWrap: 'wrap'
      }
    }, prop.zillowUrl ? /*#__PURE__*/React.createElement("a", {
      href: prop.zillowUrl,
      target: "_blank",
      rel: "noopener noreferrer",
      onClick: e => e.stopPropagation(),
      style: {
        color: C.gold,
        textDecoration: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3
      }
    }, /*#__PURE__*/React.createElement("i", {
      className: "ti ti-external-link",
      style: {
        fontSize: 11
      }
    }), "Zillow") : null, prop.zillowUrl && prop.agent ? /*#__PURE__*/React.createElement("span", null, "\xB7") : null, prop.agent ? /*#__PURE__*/React.createElement("span", null, prop.agent) : null)), /*#__PURE__*/React.createElement(Icon.Chevron, {
      size: 13,
      color: C.textSecondary,
      down: isOpen
    })), isOpen && /*#__PURE__*/React.createElement("div", {
      style: {
        borderTop: `1px solid ${C.border}`,
        padding: '12px 14px'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        gap: 8,
        marginBottom: propShowings.length ? 14 : 0
      }
    }, /*#__PURE__*/React.createElement("button", {
      onClick: () => handleRestore(prop),
      style: {
        flex: 1,
        padding: '8px',
        background: 'none',
        color: C.navy,
        border: `1px solid ${C.navy}55`,
        borderRadius: 8,
        fontSize: '0.8rem',
        cursor: 'pointer',
        fontFamily: C.fontSans,
        fontWeight: 500
      }
    }, /*#__PURE__*/React.createElement("i", {
      className: "ti ti-refresh",
      style: {
        marginRight: 5,
        fontSize: 12
      }
    }), "Restore"), /*#__PURE__*/React.createElement("button", {
      onClick: () => handleDeleteForever(prop),
      style: {
        flex: 1,
        padding: '8px',
        background: 'none',
        color: C.red,
        border: `1px solid ${C.red}55`,
        borderRadius: 8,
        fontSize: '0.8rem',
        cursor: 'pointer',
        fontFamily: C.fontSans
      }
    }, /*#__PURE__*/React.createElement("i", {
      className: "ti ti-trash",
      style: {
        marginRight: 5,
        fontSize: 12
      }
    }), "Delete Forever")), propShowings.length > 0 && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: '0.62rem',
        fontWeight: 600,
        color: C.navy,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        marginBottom: 8,
        fontFamily: C.fontSans
      }
    }, "Showing History"), propShowings.map(s => {
      const thread = threads[s.id] || [];
      return /*#__PURE__*/React.createElement("div", {
        key: s.id,
        style: {
          background: C.bg,
          borderRadius: 8,
          padding: '10px 12px',
          marginBottom: 8
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: '0.85rem',
          fontWeight: 500,
          color: C.textPrimary,
          marginBottom: 2
        }
      }, s.agent), /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: '0.72rem',
          color: C.textSecondary,
          marginBottom: thread.length ? 8 : 0
        }
      }, s.date, " \xB7 ", s.phone), thread.length > 0 && /*#__PURE__*/React.createElement(SmsThread, {
        thread: thread
      }));
    }))));
  }));
}

// ─── Settings Tab ─────────────────────────────────────────────────

// Renders a template body by replacing all placeholders with real values.
// showing  → { agent_name, property_address }
// property → { address, agent (listing agent name) }
// user     → Supabase user object
function renderTemplate(body, showing, property, user) {
  const agentFirst = (showing?.agent_name || '').split(' ')[0] || '{{agent_first_name}}';
  const streetAddr = property?.address || showing?.property_address || '{{address}}';
  const senderFirst = (user?.user_metadata?.full_name || '').split(' ')[0] || '{{my_name}}';
  const listingAgent = property?.agent || '{{listing_agent}}';
  const zillowUrl = property?.zillowUrl || '{{zillow_url}}';
  return body.replace(/\{\{agent_first_name\}\}/g, agentFirst).replace(/\{\{address\}\}/g, streetAddr).replace(/\{\{my_name\}\}/g, senderFirst).replace(/\{\{listing_agent\}\}/g, listingAgent).replace(/\{\{zillow_url\}\}/g, zillowUrl);
}

// Fixed Twilio sending number (A2P 10DLC registration pending).
const SMS_PHONE = '(512) 610-1095';
const SMS_TEMPLATE_DEFAULTS = [{
  touch: 1,
  day: 1,
  label: 'Follow-up 1 · Day 1',
  body: "Hi {{agent_first_name}}! This is {{my_name}} with The Morshed Group, reaching out on behalf of our listing agent {{listing_agent}}. Just following up on your showing at {{address}} — did your clients enjoy the property? Any feedback would be greatly appreciated! 🏡"
}, {
  touch: 2,
  day: 2,
  label: 'Follow-up 2 · Day 2',
  body: "Hi {{agent_first_name}}, this is {{my_name}} again from The Morshed Group — just checking back in on {{address}}. Did your clients have any thoughts they'd like to share? {{listing_agent}} would love to hear from you!"
}, {
  touch: 3,
  day: 3,
  label: 'Follow-up 3 · Day 3',
  body: "Hi {{agent_first_name}}, one last follow-up on {{address}}. Feel free to reach out anytime if your clients have questions for {{listing_agent}}. Thanks so much for showing the property!"
}, {
  touch: 4,
  day: null,
  label: 'Reply Received',
  body: "Thanks for the feedback!\n\n{{my_name}}\nThe Morshed Group"
}];
function SettingsModal({
  user,
  onClose
}) {
  const fullName = user?.user_metadata?.full_name || 'User';
  const email = user?.email || '';
  const initial = fullName.charAt(0).toUpperCase();
  const [templates, setTemplates] = useState(SMS_TEMPLATE_DEFAULTS.map(t => t.body));
  const [tmplSaving, setTmplSaving] = useState(false);
  const [tmplSaved, setTmplSaved] = useState(false);
  useEffect(() => {
    DB.loadTemplates().then(bodies => setTemplates(bodies));
  }, []);
  async function handleSaveTemplates() {
    setTmplSaving(true);
    setTmplSaved(false);
    try {
      await DB.saveTemplates(templates, user);
      setTmplSaved(true);
      setTimeout(() => setTmplSaved(false), 3000);
    } catch (e) {
      console.error('[Settings] saveTemplates:', e.message);
    } finally {
      setTmplSaving(false);
    }
  }
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    onClick: onClose,
    style: {
      position: 'fixed',
      inset: 0,
      zIndex: 300,
      background: 'rgba(0,26,74,0.45)'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'fixed',
      left: 0,
      right: 0,
      bottom: 0,
      zIndex: 301,
      background: C.surface,
      borderRadius: '20px 20px 0 0',
      padding: '24px 20px 40px',
      boxShadow: '0 -4px 32px rgba(0,26,74,0.15)',
      maxHeight: '85vh',
      overflowY: 'auto'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 20
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '1.2rem',
      fontStyle: 'italic',
      fontFamily: C.fontDisplay,
      color: C.navy
    }
  }, "Settings"), /*#__PURE__*/React.createElement("button", {
    onClick: onClose,
    style: {
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      padding: 4,
      color: C.textMuted,
      fontSize: 20,
      display: 'flex'
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-x"
  }))), /*#__PURE__*/React.createElement(SectionCard, {
    title: "Account",
    mb: 14
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 14,
      marginBottom: 18
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 44,
      height: 44,
      borderRadius: '50%',
      background: C.navy,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: C.goldSoft,
      fontWeight: 300,
      fontSize: '1.2rem',
      fontFamily: C.fontSans,
      flexShrink: 0
    }
  }, initial), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      color: C.textPrimary,
      fontWeight: 600,
      fontSize: '0.95rem'
    }
  }, fullName), /*#__PURE__*/React.createElement("div", {
    style: {
      color: C.textSecondary,
      fontSize: '0.8rem',
      marginTop: 2
    }
  }, email))), /*#__PURE__*/React.createElement(ActionButton, {
    label: "Sign out",
    danger: true,
    onClick: () => window.SupabaseAuth.signOut()
  })), /*#__PURE__*/React.createElement(SectionCard, {
    title: "How This Works",
    mb: 14
  }, /*#__PURE__*/React.createElement("ol", {
    style: {
      margin: 0,
      paddingLeft: 18,
      color: C.textSecondary,
      fontSize: '0.78rem',
      lineHeight: 1.9
    }
  }, /*#__PURE__*/React.createElement("li", null, "Add the ", /*#__PURE__*/React.createElement("b", {
    style: {
      color: C.textPrimary
    }
  }, "property"), "."), /*#__PURE__*/React.createElement("li", null, "Add a ", /*#__PURE__*/React.createElement("b", {
    style: {
      color: C.textPrimary
    }
  }, "showing"), " for that property (agent + phone)."), /*#__PURE__*/React.createElement("li", null, "Up to ", /*#__PURE__*/React.createElement("b", {
    style: {
      color: C.textPrimary
    }
  }, "3 follow-up texts"), " go out automatically, a couple of days apart."), /*#__PURE__*/React.createElement("li", null, "When the agent ", /*#__PURE__*/React.createElement("b", {
    style: {
      color: C.textPrimary
    }
  }, "replies"), ", that reply is logged to the thread, folded into the property's Feedback automatically, and the ", /*#__PURE__*/React.createElement("b", {
    style: {
      color: C.textPrimary
    }
  }, "\"Reply Received\""), " template below goes out automatically."), /*#__PURE__*/React.createElement("li", null, "The showing is ", /*#__PURE__*/React.createElement("b", {
    style: {
      color: C.textPrimary
    }
  }, "closed automatically"), " and shows up in ", /*#__PURE__*/React.createElement("b", {
    style: {
      color: C.textPrimary
    }
  }, "Generate Summary"), " \u2014 no manual status change or copy-pasting the reply required."))), /*#__PURE__*/React.createElement(SectionCard, {
    title: "SMS Follow-up Templates",
    mb: 14
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.78rem',
      color: C.textSecondary,
      marginBottom: 14,
      lineHeight: 1.8
    }
  }, "Available placeholders:", ' ', /*#__PURE__*/React.createElement("span", {
    style: {
      color: C.gold,
      fontFamily: 'monospace'
    }
  }, '{{agent_first_name}}'), ' · ', /*#__PURE__*/React.createElement("span", {
    style: {
      color: C.gold,
      fontFamily: 'monospace'
    }
  }, '{{address}}'), ' · ', /*#__PURE__*/React.createElement("span", {
    style: {
      color: C.gold,
      fontFamily: 'monospace'
    }
  }, '{{my_name}}'), ' · ', /*#__PURE__*/React.createElement("span", {
    style: {
      color: C.gold,
      fontFamily: 'monospace'
    }
  }, '{{listing_agent}}'), ' · ', /*#__PURE__*/React.createElement("span", {
    style: {
      color: C.gold,
      fontFamily: 'monospace'
    }
  }, '{{zillow_url}}')), SMS_TEMPLATE_DEFAULTS.map((t, i) => /*#__PURE__*/React.createElement("div", {
    key: t.touch,
    style: {
      marginBottom: i < SMS_TEMPLATE_DEFAULTS.length - 1 ? 14 : 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.62rem',
      fontWeight: 500,
      color: C.navy,
      letterSpacing: '0.18em',
      textTransform: 'uppercase',
      marginBottom: 6,
      fontFamily: C.fontSans
    }
  }, t.label), /*#__PURE__*/React.createElement("textarea", {
    value: templates[i],
    onChange: e => {
      const n = [...templates];
      n[i] = e.target.value;
      setTemplates(n);
    },
    rows: 3,
    style: {
      width: '100%',
      background: C.bg,
      border: `1px solid ${C.border}`,
      borderRadius: 10,
      padding: '10px 12px',
      color: C.textPrimary,
      fontSize: '0.83rem',
      lineHeight: 1.6,
      resize: 'none',
      fontFamily: C.fontSans,
      outline: 'none'
    }
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 14
    }
  }, /*#__PURE__*/React.createElement(ActionButton, {
    label: tmplSaving ? 'Saving…' : tmplSaved ? 'Saved ✓' : 'Save Templates',
    onClick: handleSaveTemplates
  }))), /*#__PURE__*/React.createElement(SectionCard, {
    title: "SMS Configuration",
    mb: 14
  }, /*#__PURE__*/React.createElement(SettingsField, {
    label: "Phone Number",
    value: SMS_PHONE,
    readOnly: true
  })), /*#__PURE__*/React.createElement(ArchivedProperties, null)));
}
function SectionCard({
  title,
  children,
  mb = 0
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.surface,
      boxShadow: '0 2px 8px rgba(0,26,74,0.07), 0 1px 2px rgba(0,26,74,0.04)',
      borderRadius: 14,
      padding: 16,
      marginBottom: mb
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.72rem',
      fontWeight: 600,
      color: C.navy,
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
      marginBottom: 14,
      fontFamily: C.fontSans
    }
  }, title), children);
}
function ActionButton({
  label,
  onClick,
  danger = false
}) {
  return /*#__PURE__*/React.createElement("button", {
    onClick: onClick,
    style: {
      width: '100%',
      padding: 12,
      background: danger ? 'none' : C.navy,
      border: `1px solid ${danger ? C.red : C.navy}`,
      borderRadius: 12,
      color: danger ? C.red : '#FFFFFF',
      fontSize: '15px',
      cursor: 'pointer',
      fontWeight: 500,
      fontFamily: C.fontSans
    }
  }, label);
}
function SettingsField({
  label,
  placeholder,
  value,
  onChange,
  readOnly = false,
  badge = null
}) {
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      marginBottom: 5
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.72rem',
      fontWeight: 600,
      color: C.textSecondary
    }
  }, label), badge && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: '0.6rem',
      fontWeight: 600,
      letterSpacing: '0.06em',
      textTransform: 'uppercase',
      color: C.gold,
      background: `${C.gold}1A`,
      border: `1px solid ${C.gold}55`,
      borderRadius: 6,
      padding: '1px 7px',
      fontFamily: C.fontSans
    }
  }, badge)), /*#__PURE__*/React.createElement("input", {
    placeholder: placeholder,
    value: value || '',
    onChange: onChange,
    readOnly: readOnly,
    tabIndex: readOnly ? -1 : undefined,
    style: {
      width: '100%',
      padding: '10px 12px',
      background: readOnly ? C.bg : C.surfaceHover,
      border: `1px solid ${C.border}`,
      borderRadius: 10,
      color: readOnly ? C.textSecondary : C.textPrimary,
      fontSize: '0.87rem',
      outline: 'none',
      fontFamily: C.fontSans,
      cursor: readOnly ? 'default' : 'text'
    }
  }));
}

// ─── Add Property Modal ───────────────────────────────────────────
function AddPropertyModal({
  onClose,
  onAdd,
  user
}) {
  const [address, setAddress] = useState('');
  const [zillowUrl, setZillowUrl] = useState('');
  const [agent, setAgent] = useState('');
  const [agents, setAgents] = useState([]);
  useEffect(() => {
    DB.loadAgents().then(setAgents);
  }, []);
  const inputStyle = {
    width: '100%',
    padding: '9px 12px',
    border: `1px solid ${C.border}`,
    borderRadius: 8,
    background: C.surface,
    color: C.textPrimary,
    fontSize: '0.88rem',
    fontFamily: C.fontSans,
    outline: 'none'
  };
  const labelStyle = {
    fontSize: '0.65rem',
    color: C.textSecondary,
    marginBottom: 4,
    fontFamily: C.fontSans,
    textTransform: 'uppercase',
    letterSpacing: '0.1em'
  };
  async function handleSubmit() {
    if (!address.trim()) return;
    const formData = {
      address: address.trim(),
      zillowUrl: zillowUrl.trim(),
      agent: agent.trim()
    };
    try {
      const newProperty = await DB.insertProperty(formData, user);
      onAdd(newProperty);
      onClose();
    } catch (e) {
      console.error('[AddProperty]', e);
      alert('Failed to save property. Please try again.');
    }
  }
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    onClick: onClose,
    style: {
      position: 'fixed',
      inset: 0,
      zIndex: 300,
      background: 'rgba(0,26,74,0.45)'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'fixed',
      left: 0,
      right: 0,
      bottom: 0,
      zIndex: 301,
      background: C.surface,
      borderRadius: '20px 20px 0 0',
      padding: '24px 20px 40px',
      boxShadow: '0 -4px 32px rgba(0,26,74,0.15)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 20
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '1.2rem',
      fontStyle: 'italic',
      fontFamily: C.fontDisplay,
      color: C.navy
    }
  }, "Add Property"), /*#__PURE__*/React.createElement("button", {
    onClick: onClose,
    style: {
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      padding: 4,
      color: C.textMuted,
      fontSize: 20,
      display: 'flex'
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-x"
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: labelStyle
  }, "Property Address *"), /*#__PURE__*/React.createElement("input", {
    value: address,
    onChange: e => setAddress(e.target.value),
    placeholder: "e.g. 1808 Forest Hill Dr, Austin TX",
    style: inputStyle
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: labelStyle
  }, "Zillow URL"), /*#__PURE__*/React.createElement("input", {
    value: zillowUrl,
    onChange: e => setZillowUrl(e.target.value),
    placeholder: "https://www.zillow.com/homedetails/\u2026",
    style: inputStyle
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: labelStyle
  }, "Listing Agent"), /*#__PURE__*/React.createElement(AgentSelect, {
    value: agent,
    onChange: setAgent,
    agents: agents,
    style: inputStyle
  }))), /*#__PURE__*/React.createElement("button", {
    onClick: handleSubmit,
    style: {
      marginTop: 20,
      width: '100%',
      padding: 14,
      background: address.trim() ? C.navy : C.border,
      color: address.trim() ? '#fff' : C.textMuted,
      border: 'none',
      borderRadius: 12,
      fontSize: '0.9rem',
      fontWeight: 500,
      cursor: address.trim() ? 'pointer' : 'default',
      fontFamily: C.fontSans,
      transition: 'background 0.15s'
    }
  }, "Add Property")));
}

// ─── Add Showing Modal ────────────────────────────────────────────
function AddShowingModal({
  onClose,
  onAdd,
  user,
  properties
}) {
  const [pid, setPid] = useState((properties || PROPERTIES)[0]?.id || '');
  const [agent, setAgent] = useState('');
  const [phone, setPhone] = useState('');
  const [office, setOffice] = useState('');
  const [date, setDate] = useState('');
  const [pasteRow, setPasteRow] = useState('');
  const [parsed, setParsed] = useState(false);
  function parseSupraRow(text) {
    // Supra table copies as tab-separated: Date | Key Serial | Keyholder | Phone | Office | Office Phone
    const parts = text.trim().split('\t').map(s => s.trim());
    if (parts.length < 5) return null;
    const datePart = (parts[0] || '').split(' ')[0]; // "5/27/2026"
    let dateStr = '';
    if (datePart && datePart.includes('/')) {
      const [m, d, y] = datePart.split('/');
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const mIdx = parseInt(m, 10) - 1;
      if (months[mIdx]) dateStr = `${months[mIdx]} ${parseInt(d, 10)}, ${y}`;
    }
    return {
      date: dateStr,
      agent: parts[2] || '',
      phone: parts[3] || '',
      office: parts[4] || ''
    };
  }
  function handlePaste(text) {
    setPasteRow(text);
    setParsed(false);
    const result = parseSupraRow(text);
    if (result) {
      if (result.agent) setAgent(result.agent);
      if (result.phone) setPhone(result.phone);
      if (result.office) setOffice(result.office);
      if (result.date) setDate(result.date);
      setParsed(true);
    }
  }
  const inputStyle = {
    width: '100%',
    padding: '9px 12px',
    border: `1px solid ${C.border}`,
    borderRadius: 8,
    background: C.surface,
    color: C.textPrimary,
    fontSize: '0.88rem',
    fontFamily: C.fontSans,
    outline: 'none'
  };
  const labelStyle = {
    fontSize: '0.65rem',
    color: C.textSecondary,
    marginBottom: 4,
    fontFamily: C.fontSans,
    textTransform: 'uppercase',
    letterSpacing: '0.1em'
  };
  async function handleSubmit() {
    if (!agent.trim()) return;
    const property = (properties || PROPERTIES).find(p => p.id === pid) || getProperty(pid);
    const formData = {
      pid,
      agent: agent.trim(),
      phone: phone.trim(),
      office: office.trim(),
      date: date.trim()
    };
    try {
      const newShowing = await DB.insertShowing(formData, property, user);
      onAdd(newShowing);
      onClose();
    } catch (e) {
      console.error('[AddShowing]', e);
      alert('Failed to save showing. Please try again.');
    }
  }
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    onClick: onClose,
    style: {
      position: 'fixed',
      inset: 0,
      zIndex: 300,
      background: 'rgba(0,26,74,0.45)'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'fixed',
      left: 0,
      right: 0,
      bottom: 0,
      zIndex: 301,
      background: C.surface,
      borderRadius: '20px 20px 0 0',
      padding: '24px 20px 40px',
      boxShadow: '0 -4px 32px rgba(0,26,74,0.15)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 20
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '1.2rem',
      fontStyle: 'italic',
      fontFamily: C.fontDisplay,
      color: C.navy
    }
  }, "Add Showing"), /*#__PURE__*/React.createElement("button", {
    onClick: onClose,
    style: {
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      padding: 4,
      color: C.textMuted,
      fontSize: 20,
      display: 'flex'
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-x"
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: labelStyle
  }, "Paste Supra Row ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: C.textMuted,
      textTransform: 'none',
      letterSpacing: 0,
      fontSize: '0.6rem'
    }
  }, "(optional \u2014 auto-fills fields below)")), /*#__PURE__*/React.createElement("textarea", {
    value: pasteRow,
    onChange: e => handlePaste(e.target.value),
    placeholder: "Copy a row from SupraWEB and paste here",
    rows: 2,
    style: {
      ...inputStyle,
      resize: 'none',
      lineHeight: 1.5,
      background: parsed ? '#F0FAF4' : C.surface,
      borderColor: parsed ? '#1E6B40' : C.border,
      transition: 'border-color 0.2s, background 0.2s'
    }
  }), parsed && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.68rem',
      color: C.green,
      marginTop: 4,
      display: 'flex',
      alignItems: 'center',
      gap: 4
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-circle-check",
    style: {
      fontSize: 13
    }
  }), "Fields filled below \u2014 review and edit if needed")), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 1,
      background: C.border
    }
  }), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: labelStyle
  }, "Property"), /*#__PURE__*/React.createElement("select", {
    value: pid,
    onChange: e => setPid(e.target.value),
    style: {
      ...inputStyle,
      appearance: 'none',
      WebkitAppearance: 'none'
    }
  }, (properties || PROPERTIES).map(p => /*#__PURE__*/React.createElement("option", {
    key: p.id,
    value: p.id
  }, p.address)))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: labelStyle
  }, "Agent Name *"), /*#__PURE__*/React.createElement("input", {
    value: agent,
    onChange: e => setAgent(e.target.value),
    placeholder: "e.g. Jane Smith",
    style: inputStyle
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: labelStyle
  }, "Phone"), /*#__PURE__*/React.createElement("input", {
    value: phone,
    onChange: e => setPhone(e.target.value),
    placeholder: "e.g. (512) 555-1234",
    style: inputStyle
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: labelStyle
  }, "Brokerage / Office"), /*#__PURE__*/React.createElement("input", {
    value: office,
    onChange: e => setOffice(e.target.value),
    placeholder: "e.g. Compass RE Texas",
    style: inputStyle
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: labelStyle
  }, "Date & Time"), /*#__PURE__*/React.createElement("input", {
    value: date,
    onChange: e => setDate(e.target.value),
    placeholder: "e.g. Jun 7, 10:30 AM",
    style: inputStyle
  }))), /*#__PURE__*/React.createElement("button", {
    onClick: handleSubmit,
    style: {
      marginTop: 20,
      width: '100%',
      padding: 14,
      background: agent.trim() ? C.navy : C.border,
      color: agent.trim() ? '#fff' : C.textMuted,
      border: 'none',
      borderRadius: 12,
      fontSize: '0.9rem',
      fontWeight: 500,
      cursor: agent.trim() ? 'pointer' : 'default',
      fontFamily: C.fontSans,
      transition: 'background 0.15s'
    }
  }, "Add Showing")));
}

// ─── Top Bar ──────────────────────────────────────────────────────
function TopBar({
  dark,
  onToggleDark,
  onAddProperty,
  onAddShowing,
  onSettings
}) {
  const iconBtn = (onClick, iconClass, title) => /*#__PURE__*/React.createElement("button", {
    onClick: onClick,
    title: title,
    style: {
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      padding: '4px 7px',
      color: 'rgba(255,255,255,0.65)',
      fontSize: 18,
      lineHeight: 1,
      display: 'flex',
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: iconClass
  }));
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '12px 16px',
      paddingTop: 'calc(12px + env(safe-area-inset-top))',
      background: 'rgba(0,26,74,0.88)',
      backdropFilter: 'blur(20px) saturate(180%)',
      WebkitBackdropFilter: 'blur(20px) saturate(180%)',
      borderBottom: '1px solid rgba(255,255,255,0.08)',
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.95rem',
      fontWeight: 300,
      color: C.goldSoft,
      letterSpacing: '0.26em',
      textTransform: 'uppercase',
      fontFamily: C.fontSans
    }
  }, "SFFU APP"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 0
    }
  }, iconBtn(onToggleDark, dark ? 'ti ti-sun' : 'ti ti-moon', dark ? 'Light mode' : 'Dark mode'), /*#__PURE__*/React.createElement("div", {
    style: {
      width: 1,
      height: 16,
      background: 'rgba(255,255,255,0.15)',
      margin: '0 4px'
    }
  }), iconBtn(onAddProperty, 'ti ti-home-plus', 'Add Property'), iconBtn(onAddShowing, 'ti ti-calendar-plus', 'Add Showing'), iconBtn(onSettings, 'ti ti-settings', 'Settings')));
}

// ─── Root App ─────────────────────────────────────────────────────
function App({
  user
}) {
  const [showAddModal, setShowAddModal] = useState(false);
  const [showAddPropModal, setShowAddPropModal] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [liveShowings, setLiveShowings] = useState([]);
  const [liveProperties, setLiveProperties] = useState(PROPERTIES);
  const [dark, setDark] = useState(() => EMBED_THEME ? EMBED_THEME === 'dark' : localStorage.getItem('sffu-theme') === 'dark');

  // Load showings and properties from DB on mount
  useEffect(() => {
    DB.loadShowings().then(data => setLiveShowings(data));
    DB.loadProperties().then(data => setLiveProperties(data));
  }, []);
  useEffect(() => {
    document.body.classList.toggle('dark', dark);
    localStorage.setItem('sffu-theme', dark ? 'dark' : 'light');
  }, [dark]);

  // When embedded in TMG, the header-row buttons drive these actions via postMessage.
  useEffect(() => {
    if (!EMBED) return;
    const onMsg = e => {
      if (e.origin !== location.origin || !e.data || e.data.tmg !== 'sffu') return;
      if (e.data.action === 'add-property') setShowAddPropModal(true);else if (e.data.action === 'add-showing') setShowAddModal(true);else if (e.data.action === 'toggle-settings') setShowSettings(s => !s);
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);
  function handleShowingAdded(newShowing) {
    setLiveShowings(prev => [newShowing, ...prev]);
  }
  function handlePropertyAdded(newProperty) {
    setLiveProperties(prev => [newProperty, ...prev]);
  }
  function handlePropertyArchived(propId) {
    setLiveProperties(prev => prev.filter(p => p.id !== propId));
  }
  function handleShowingDeleted(showingId) {
    setLiveShowings(prev => prev.filter(s => s.id !== showingId));
  }
  return /*#__PURE__*/React.createElement("div", {
    style: {
      height: '100%',
      background: dark ? '#000D26' : C.bg,
      display: 'flex',
      flexDirection: 'column',
      color: C.textPrimary,
      transition: 'background 0.2s ease'
    }
  }, !EMBED && /*#__PURE__*/React.createElement(TopBar, {
    dark: dark,
    onToggleDark: () => setDark(d => !d),
    onAddProperty: () => setShowAddPropModal(true),
    onAddShowing: () => setShowAddModal(true),
    onSettings: () => setShowSettings(s => !s)
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      overflowY: 'auto',
      WebkitOverflowScrolling: 'touch'
    }
  }, /*#__PURE__*/React.createElement(OverviewTab, {
    user: user,
    liveShowings: liveShowings,
    properties: liveProperties,
    onArchive: handlePropertyArchived,
    onDeleteShowing: handleShowingDeleted
  })), showSettings && /*#__PURE__*/React.createElement(SettingsModal, {
    user: user,
    onClose: () => setShowSettings(false)
  }), showAddPropModal && /*#__PURE__*/React.createElement(AddPropertyModal, {
    onClose: () => setShowAddPropModal(false),
    onAdd: handlePropertyAdded,
    user: user
  }), showAddModal && /*#__PURE__*/React.createElement(AddShowingModal, {
    onClose: () => setShowAddModal(false),
    onAdd: handleShowingAdded,
    user: user,
    properties: liveProperties
  }));
}

// ─── Mount ────────────────────────────────────────────────────────
(function mount() {
  const root = ReactDOM.createRoot(document.getElementById('root'));
  function showSignin() {
    document.getElementById('auth-signin').style.display = 'flex';
    document.getElementById('auth-rejected').style.display = 'none';
    document.getElementById('auth-overlay').style.display = 'flex';
  }
  function showRejected() {
    document.getElementById('auth-signin').style.display = 'none';
    document.getElementById('auth-rejected').style.display = 'flex';
    document.getElementById('auth-overlay').style.display = 'flex';
  }
  function hideOverlay() {
    document.getElementById('auth-overlay').style.display = 'none';
  }
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.protocol === 'file:') {
    root.render( /*#__PURE__*/React.createElement(App, {
      user: window.SupabaseAuth._state.session?.user
    }));
    hideOverlay();
    return;
  }
  window.SupabaseAuth.onAuthStateChange(function ({
    session
  }) {
    if (!session) {
      showSignin();
      return;
    }
    root.render( /*#__PURE__*/React.createElement(App, {
      user: session.user
    }));
    hideOverlay();
  });
})();