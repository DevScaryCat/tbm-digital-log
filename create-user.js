const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

// Parse .env.local manually
const envFile = fs.readFileSync('.env.local', 'utf8');
const env = {};
envFile.split('\n').forEach(line => {
  const match = line.match(/^([^=]+)=(.*)$/);
  if (match) {
    env[match[1]] = match[2];
  }
});

const supabase = createClient(
  env['NEXT_PUBLIC_SUPABASE_URL'],
  env['SUPABASE_SERVICE_ROLE_KEY']
);

async function createTestUser() {
  console.log("Creating user...");
  // test ID maps to test@tbm.com
  const { data: user, error: userError } = await supabase.auth.admin.createUser({
    email: 'test@tbm.com',
    password: 'test',
    email_confirm: true,
  });

  if (userError) {
    if (userError.message.includes('Password should be at least 6 characters')) {
       console.log("Password 4 chars failed. Using testtest");
       const retry = await supabase.auth.admin.createUser({
         email: 'test@tbm.com',
         password: 'testtest',
         email_confirm: true,
       });
       if (retry.error) {
           console.error("Retry failed:", retry.error);
       } else {
           console.log("Created successfully with testtest. User ID:", retry.data.user.id);
       }
    } else {
        console.error("Error generating user:", userError);
    }
  } else {
    console.log("Created test user:", user?.user?.id);
  }

  // update profile structure if any
  const profiles = await supabase.from('profiles').select('*').limit(1);
  if (profiles.error) {
     console.log("No profiles table found or error:", profiles.error.message);
  } else {
     // If profile table requires company_name
     console.log("Found profiles table, let's upsert company_name");
     const userId = (user && user.user) ? user.user.id : null;
     if (userId) {
         await supabase.from('profiles').upsert({ id: userId, company_name: '테스트' });
         console.log("Profile updated!");
     }
  }
}

createTestUser();
