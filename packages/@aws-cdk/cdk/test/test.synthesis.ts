import cxapi = require('@aws-cdk/cx-api');
import fs = require('fs');
import { Test } from 'nodeunit';
import os = require('os');
import path = require('path');
import cdk = require('../lib');
import { FileSystemStore, SynthesisSession } from '../lib';

const storeTestMatrix: any = {};

function createModernApp() {
  return new cdk.App({
    context: {
      [cxapi.DISABLE_LEGACY_MANIFEST_CONTEXT]: 'true',
      [cxapi.DISABLE_VERSION_REPORTING]: 'true', // for test reproducibility
    }
  });
}

export = {
  'synthesis with an empty app'(test: Test) {
    // GIVEN
    const app = createModernApp();

    // WHEN
    const session = app.run();

    // THEN
    test.same(app.run(), session); // same session if we run() again
    test.deepEqual(session.assembly.list(), [ 'manifest.json' ]);
    test.deepEqual(session.assembly.readJson('manifest.json').artifacts, {});
    test.done();
  },

  'single empty stack'(test: Test) {
    // GIVEN
    const app = createModernApp();
    new cdk.Stack(app, 'one-stack');

    // WHEN
    const session = app.run();

    // THEN
    test.deepEqual(session.assembly.list(), [
      'manifest.json',
      'one-stack.template.json'
    ]);
    test.done();
  },

  'some random construct implements "synthesize"'(test: Test) {
    // GIVEN
    const app = createModernApp();
    const stack = new cdk.Stack(app, 'one-stack');

    class MyConstruct extends cdk.Construct implements cdk.ISynthesizable {
      public synthesize(s: cdk.ISynthesisSession) {
        s.assembly.writeJson('foo.json', { bar: 123 });
        s.addArtifact('my-random-construct', {
          type: cxapi.ArtifactType.AwsCloudFormationStack,
          environment: 'aws://12345/bar',
          properties: {
            templateFile: 'file://boom'
          }
        });
      }
    }

    new MyConstruct(stack, 'MyConstruct');

    // WHEN
    const session = app.run();

    // THEN
    test.deepEqual(session.assembly.list(), [
      'foo.json',
      'manifest.json',
      'one-stack.template.json'
    ]);
    test.deepEqual(session.assembly.readJson('foo.json'), { bar: 123 });
    test.deepEqual(session.manifest, {
      version: '0.19.0',
      artifacts: {
        'my-random-construct': {
          type: 'aws:cloudformation:stack',
          environment: 'aws://12345/bar',
          properties: { templateFile: 'file://boom' }
        },
        'one-stack': {
          type: 'aws:cloudformation:stack',
          environment: 'aws://unknown-account/unknown-region',
          properties: { templateFile: 'one-stack.template.json' },
        }
      },
    });
    test.done();
  },

  'store': storeTestMatrix
};

//
// all these tests will be executed for each type of store
//
const storeTests = {
  'writeFile()/readFile()'(test: Test, store: cdk.ISessionStore) {
    // WHEN
    store.writeFile('bla.txt', 'hello');
    store.writeFile('hey.txt', '1234');

    // THEN
    test.deepEqual(store.readFile('bla.txt').toString(), 'hello');
    test.deepEqual(store.readFile('hey.txt').toString(), '1234');
    test.throws(() => store.writeFile('bla.txt', 'override is forbidden'));

    // WHEN
    store.lock();

    // THEN
    test.throws(() => store.writeFile('another.txt', 'locked!'));
    test.done();
  },

  'exists() for files'(test: Test, store: cdk.ISessionStore) {
    // WHEN
    store.writeFile('A.txt', 'aaa');

    // THEN
    test.ok(store.exists('A.txt'));
    test.ok(!store.exists('B.txt'));
    test.done();
  },

  'mkdir'(test: Test, store: cdk.ISessionStore) {
    // WHEN
    const dir1 = store.mkdir('dir1');
    const dir2 = store.mkdir('dir2');

    // THEN
    test.ok(fs.statSync(dir1).isDirectory());
    test.ok(fs.statSync(dir2).isDirectory());
    test.throws(() => store.mkdir('dir1'));

    // WHEN
    store.lock();
    test.throws(() => store.mkdir('dir3'));
    test.done();
  },

  'list'(test: Test, store: cdk.ISessionStore) {
    // WHEN
    store.mkdir('dir1');
    store.writeFile('file1.txt', 'boom1');

    // THEN
    test.deepEqual(store.list(), ['dir1', 'file1.txt']);
    test.done();
  },

  'SynthesisSession'(test: Test, store: cdk.ISessionStore) {
    // GIVEN
    const session = new SynthesisSession({ store });
    const templateFile = 'foo.template.json';

    // WHEN
    session.addArtifact('my-first-artifact', {
      type: cxapi.ArtifactType.AwsCloudFormationStack,
      environment: 'aws://1222344/us-east-1',
      dependencies: ['a', 'b'],
      metadata: {
        foo: { bar: 123 }
      },
      properties: {
        templateFile,
        parameters: {
          prop1: '1234',
          prop2: '555'
        }
      },
      missing: {
        foo: {
          provider: 'context-provider',
          props: {
            a: 'A',
            b: 2
          }
        }
      }
    });

    session.addArtifact('minimal-artifact', {
      type: cxapi.ArtifactType.AwsCloudFormationStack,
      environment: 'aws://111/helo-world',
      properties: {
        templateFile
      }
    });

    session.assembly.writeJson(templateFile, {
      Resources: {
        MyTopic: {
          Type: 'AWS::S3::Topic'
        }
      }
    });

    session.close();

    const manifest = session.assembly.readJson(cxapi.MANIFEST_FILE);

    // THEN
    delete manifest.runtime; // deterministic tests

    // verify the manifest looks right
    test.deepEqual(manifest, {
      version: cxapi.PROTO_RESPONSE_VERSION,
      artifacts: {
        'my-first-artifact': {
          type: 'aws:cloudformation:stack',
          environment: 'aws://1222344/us-east-1',
          dependencies: ['a', 'b'],
          metadata: { foo: { bar: 123 } },
          properties: {
            templateFile: 'foo.template.json',
            parameters: {
              prop1: '1234',
              prop2: '555'
            },
          },
          missing: {
            foo: { provider: 'context-provider', props: { a: 'A', b: 2 } }
          }
        },
        'minimal-artifact': {
          type: 'aws:cloudformation:stack',
          environment: 'aws://111/helo-world',
          properties: { templateFile: 'foo.template.json' }
        }
      }
    });

    // verify we have a template file
    test.deepEqual(session.assembly.readJson(templateFile), {
      Resources: {
        MyTopic: {
          Type: 'AWS::S3::Topic'
        }
      }
    });

    test.done();
  },

  'stack.setParameterValue can be used to assign parameters'(test: Test) {
    // GIVEN
    const app = createModernApp();
    const stack = new cdk.Stack(app, 'my-stack');
    const param = new cdk.CfnParameter(stack, 'MyParam', { type: 'string' });

    // WHEN
    stack.setParameterValue(param, 'Foo');

    // THEN
    const session = app.run();
    const props = (session.manifest.artifacts && session.manifest.artifacts['my-stack'].properties) || {};
    test.deepEqual(props.parameters, {
      MyParam: 'Foo'
    });
    test.done();
  },

  'addBuildStep can be used to produce build.json in root of cdk.out'(test: Test) {
    // GIVEN
    const app = createModernApp();

    // WHEN
    class BuildMe extends cdk.Construct implements cdk.ISynthesizable {
      public synthesize(s: cdk.ISynthesisSession) {
        s.addBuildStep('step_id', {
          type: 'build-step-type',
          parameters: {
            boom: 123
          }
        });
      }
    }

    new BuildMe(app, 'hey');

    // THEN
    const session  = app.run();
    test.deepEqual(session.store.readJson('build.json'), {
      steps: {
        step_id: { type: 'build-step-type', parameters: { boom: 123 } }
      }
    });
    test.done();
  }
};

for (const [name, fn] of Object.entries(storeTests)) {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-tests'));
  const fsStore = new FileSystemStore({ path: outdir });
  storeTestMatrix[`FileSystemStore - ${name}`] = (test: Test) => fn(test, fsStore);
}
