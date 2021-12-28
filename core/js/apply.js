const path = require('path');
const $ = require('@znode/execa').$;
const fs = require('@znode/fs');
const spawn = require('child_process').spawn;
const parseArgs = require('yargs-parser');

const DEFAULT_SERVICE_CONFIG = path.join(process.cwd(), 'zmicro-service.yml');

async function apply(configFile = DEFAULT_SERVICE_CONFIG, options) {
  const cwd = process.cwd();
  const config = await fs.yml.load(configFile);
  if (!config.services) {
    throw new Error(`services is required`);
  }

  if (options.name) {
    if (!config.services[options.name]) {
      throw new Error(`unknown service named ${options.name}`);
    }

    const service = {
      ...config.services[options.name],
      name: options.name,
    };

    return await applyService(service, { ...options, cwd }); 
  }

  for (const name in config.services) {
    const service = {
      ...config.services[name],
      name,
    };

    await applyService(service, { ...options, cwd });
  }
}

async function applyService(service, options) {
  console.log(await $`log::info "[${service.name}] applying service ..."`);

  console.log(await $`log::info "[${service.name}] updating config ..."`);
  await createServiceConfig(service);

  if (!await isServiceExist(service.name)) {
    console.log(await $`log::info "[${service.name}] installing ..."`);
    await runCommand(`SERVICE_AUTO_START=N zmicro service install ${service.name}`);
  } else {
    console.log(await $`log::info "[${service.name}] pulling ..."`);
    await runCommand(`zmicro service pull_repo ${service.name}`);
  }

  // if (!['notion', 'vscode', 'portainer'].includes(service.name)) return;

  const action = options && options.action || 'start';
  console.log(await $`log::info "[${service.name}] ${action}ing ..."`);
  // await $`zmicro service start ${service.name}`;
  await runCommand(`zmicro service ${action} ${service.name}`);

  console.log(await $`log::info "[${service.name}] done .\n"`);
}

async function isServiceExist(name) {
  const serviceDir = `/usr/local/lib/zmicro/plugins/service/services/${name}`;
  return fs.exist(serviceDir);
}

async function createServiceConfig(service) {
  const configDir = `/configs/plugins/service/config/${service.name}`;
  const configEnvPath = `${configDir}/config`;
  const configYmlPath = `${configDir}/config.yml`;

  await fs.mkdirp(configDir);

  if (service.environment) {
    // console.log(`[${service.name}] environment:`, service.environment);

    const envPrefix = `SERVICE_${service.name.replace(/-/g, '_').toUpperCase()}`;
    const env = [];
    for (const key in service.environment) {
      let envKey = key;

      // if key start with _, it means use no prefix
      if (!/^_/.test(key)) {
        envKey = `${envPrefix}_${key}`;
      } else {
        envKey = key.slice(1);
      }
    
      const envValue = service.environment[key];
      env.push(`${envKey}="${envValue}"`);
    }

    await fs.writeFile(configEnvPath, env.join('\n'));
  }

  if (service.config) {
    await fs.yml.write(configYmlPath, service.config);
  }
}

async function runCommand(command) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, stdio: 'inherit' });
    child.on('exit', (code) => {
      if (code !== 0) return reject(`command (${command}) error (${code})`);

      resolve();
    });
  });

}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // console.log('args:', args);

  let config = args.f || args.config || DEFAULT_SERVICE_CONFIG;
  let action = args.a || args.action || 'start';
  let name = args.n || args.name;

  if (typeof config !== 'string') {
    throw new Error(`invalid service apply config`);
  }

  if (typeof action !== 'string' || !['start', 'stop', 'restart'].includes(action)) {
    throw new Error(`invalid service apply action, should only start/stop/restart`);
  }

  if (!/^\//.test(config)) {
    config = path.join(process.cwd(), config);
  }

  await apply(config, { action, name });
}

main()
  .catch(error => {
    // console.error('apply error', error);
    console.error('apply error', error.message);
    
    process.exit(1);
  });